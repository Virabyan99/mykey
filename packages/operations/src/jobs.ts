// The job queue (pg-boss in schema `jobs`, Doc 06 §6). A job carries one
// operation id and nothing else: what to do is read from the operation row,
// so no value, name or credential can ride in a job.
//
// Runtime instances never create or migrate the schema (migration 0004 does)
// and never create a queue (`ensureQueues`, run as migration_owner, does).
import type { OperationId } from "@mykey/contracts";
import { operationIdSchema } from "@mykey/contracts";
import type { Queryable } from "@mykey/db";
import { PgBoss, getConstructionPlans, type ConstructorOptions, type Db } from "pg-boss";
import type pg from "pg";
import { z } from "zod";

export const JOB_KINDS = ["environment.provision"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_SCHEMA = "jobs";

export const jobPayloadSchema = z.strictObject({ operationId: operationIdSchema });

/**
 * The SQL that creates pg-boss's objects in schema `jobs`, as migration 0004
 * holds it: pg-boss's construction plan for the pinned version without its own
 * BEGIN and COMMIT, because the migrator runs every file in one transaction.
 * `scripts/pgboss-schema.ts --check` fails when the migration no longer holds it.
 */
export function jobSchemaSql(): string {
  const plan = getConstructionPlans(JOB_SCHEMA, { createSchema: false });
  const lines = plan.split("\n");
  const begin = lines.findIndex((line) => line.trim() === "BEGIN;");
  const commit = lines.findLastIndex((line) => line.trim() === "COMMIT;");
  if (begin === -1 || commit === -1 || commit < begin) {
    throw new Error(
      "the pg-boss construction plan no longer has the expected BEGIN ... COMMIT shape",
    );
  }
  const body = lines
    .slice(begin + 1, commit)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return `${body}\n`;
}

/** Retries of a failed job: five, with exponential backoff (Run 3.8 relies on it). */
// expireInSeconds (Run 4.1, P-83): a job held by a killed worker is handed out
// again after two minutes instead of pg-boss's default fifteen. A retried step
// is compare-then-act (P-55), so a second delivery is safe.
const QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 120,
  expireInSeconds: 120,
};

function adapter(db: Queryable): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => {
      // A text of several statements answers one result per statement; pg-boss
      // unwraps that array itself (its supervisor sends such texts, Run 3.8).
      const result = (await db.query(text, values)) as unknown;
      if (Array.isArray(result)) {
        return result.map((one: { rows: unknown[] }) => ({ rows: one.rows })) as unknown as {
          rows: unknown[];
        };
      }
      return { rows: (result as { rows: unknown[] }).rows };
    },
  };
}

function options(db: Queryable, supervise: boolean): ConstructorOptions {
  return {
    db: adapter(db),
    schema: JOB_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise,
    schedule: false,
    registerInstance: false,
    openTelemetry: { enabled: false },
  };
}

async function started(db: Queryable, supervise: boolean): Promise<PgBoss> {
  const boss = new PgBoss(options(db, supervise));
  // pg-boss reports background trouble as events; without a listener an
  // `error` event would end the process. The caller sees failures of its own calls.
  boss.on("error", () => undefined);
  await boss.start();
  return boss;
}

/** Creates one queue per job kind. Idempotent; run as migration_owner after `migrate()`. */
export async function ensureQueues(pool: pg.Pool): Promise<void> {
  const boss = await started(pool, false);
  try {
    const existing = new Set((await boss.getQueues()).map((queue) => queue.name));
    for (const kind of JOB_KINDS) {
      // An existing queue takes the current options too (a host deployed before Run 4.1).
      if (existing.has(kind)) await boss.updateQueue(kind, QUEUE_OPTIONS);
      else await boss.createQueue(kind, QUEUE_OPTIONS);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

export interface JobSender {
  /** Sends one job. With `tx`, the job is part of that transaction and exists only if it commits. */
  send(
    kind: JobKind,
    operationId: OperationId,
    opts?: { tx?: pg.PoolClient; startAfterSeconds?: number },
  ): Promise<void>;
  stop(): Promise<void>;
}

export async function createSender(pool: pg.Pool): Promise<JobSender> {
  const boss = await started(pool, false);
  return {
    async send(kind, operationId, opts = {}) {
      const data = jobPayloadSchema.parse({ operationId });
      const id = await boss.send(kind, data, {
        ...(opts.tx === undefined ? {} : { db: adapter(opts.tx) }),
        ...(opts.startAfterSeconds === undefined ? {} : { startAfter: opts.startAfterSeconds }),
      });
      if (id === null) throw new Error(`job ${kind} was not created`);
    },
    stop: () => boss.stop({ graceful: false }),
  };
}

/** `lastAttempt`: the queue will not retry this job if the handler throws (Run 3.8). */
export type JobHandlers = Record<
  JobKind,
  (operationId: OperationId, meta: { lastAttempt: boolean }) => Promise<void>
>;

export async function createWorker(
  pool: pg.Pool,
  handlers: JobHandlers,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<{ stop(): Promise<void> }> {
  const boss = await started(pool, true);
  for (const kind of JOB_KINDS) {
    const handler = handlers[kind];
    await boss.work<unknown>(
      kind,
      {
        batchSize: 1,
        pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 1,
        includeMetadata: true,
      },
      async (jobs) => {
        for (const job of jobs) {
          // A job that is not exactly an operation id is refused (and fails), never interpreted.
          const payload = jobPayloadSchema.parse(job.data);
          await handler(payload.operationId, {
            lastAttempt: job.retryCount >= QUEUE_OPTIONS.retryLimit,
          });
        }
      },
    );
  }
  return { stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
