// Run 6.9 Task B (P-128, D-57): the report that opens the gate after a deploy.
// REQUIRED_CHECKS.deploy: the schema revision the release expects, OpenBao
// readable, the incarnation equal in the database, host.env and OpenBao, the
// control row idle, the journey (sign-in, a reveal's digest, a refused write)
// and the gate closed before this deploy started. Appends operator.deploy
// with the build. Counts and names only.
import { appendAudit } from "@mykey/audit";
import {
  REQUIRED_CHECKS,
  verificationReportSchema,
  type GateRecordV2,
  type VerificationReport,
} from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type { GateExpect } from "@mykey/operations";
import { openGate, type GateWriteResult, type GateWriter } from "@mykey/operations/operator";
import type pg from "pg";
import { storeChecks, type Check, type CheckAnswer, type JourneyResult } from "./restore-verify.ts";

export interface DeployVerifyDeps {
  /** The host's database (maintenance or superuser). */
  pool: pg.Pool;
  /** The host's OpenBao, with a token that may list namespaces and read mykey-meta. */
  admin: OpenBaoAdmin;
  host: string;
  expect: GateExpect;
  origin: GateRecordV2["origin"];
  /** The release's last migration. */
  schemaRevision: string;
  /** The gate record as it was when the deploy closed it (null: there was none). */
  previousGate: string | null;
  now?: () => Date;
}

const DEPLOY_STORE_CHECKS = [
  "schema_revision",
  "openbao_readable",
  "incarnation_three_places",
  "control_row_idle",
] as const;

/** The record the opening replaces, read when the report is made: closed (the deploy's own gate_close), or none. */
export function previousGateClosed(text: string | null): CheckAnswer {
  if (text === null) return { state: "ok", observed: "no record before the deploy" };
  try {
    const record = JSON.parse(text) as { state?: unknown };
    return record.state === "closed"
      ? { state: "ok", observed: "closed" }
      : { state: "failed", observed: `the record said ${String(record.state)}` };
  } catch {
    return { state: "failed", observed: "the record before the deploy did not parse" };
  }
}

/**
 * P-147 (c): the reveal check of a host whose index holds no secret: ok, and
 * it says why. For any other count null (the journey's reveal decides).
 */
export function revealCheckWithoutSecrets(secretCount: number): CheckAnswer | null {
  return secretCount === 0 ? { state: "ok", observed: "no secret in the index" } : null;
}

/**
 * P-147 (b): the journey of a host with a real owner, done by the owner in
 * their own browser through `tunnel verify`; the operator's flag says so.
 */
export function ownerConfirmedJourney(): JourneyResult {
  const confirmed: CheckAnswer = { state: "ok", observed: "owner confirmed (--owner-confirmed)" };
  return {
    checks: {
      journey_sign_in: confirmed,
      journey_reveal_digest: confirmed,
      journey_mutation_refused: confirmed,
    },
  };
}

/**
 * P-147 (d): a standalone `gate open --report`. It takes a deploy report only
 * (a restore report opens through `restore-verify --open`), and runs the four
 * store checks again right before the record is written, against the schema
 * revision the report saw.
 */
export async function openWithDeployReport(deps: {
  writer: GateWriter;
  /** As maintenance. */
  pool: pg.Pool;
  admin: OpenBaoAdmin;
  expect: GateExpect;
  report: unknown;
  now?: () => Date;
}): Promise<GateWriteResult> {
  const parsed = verificationReportSchema.safeParse(deps.report);
  if (!parsed.success) return { ok: false, cause: "the report is not a verification report" };
  const report = parsed.data;
  if (report.origin.kind === "restore") {
    return {
      ok: false,
      cause: "a restore report opens the gate only through restore-verify --open",
    };
  }
  const revision = report.checks.find((c) => c.id === "schema_revision");
  const now = deps.now ?? (() => new Date());
  return openGate({
    writer: deps.writer,
    pool: deps.pool,
    expect: deps.expect,
    report,
    kind: "deploy",
    now,
    recheck: async () => {
      const all = storeChecks({
        pool: deps.pool,
        admin: deps.admin,
        host: report.host,
        expect: deps.expect,
        origin: report.origin,
        schemaRevision: revision?.state === "ok" ? revision.observed : "",
        restoreStartedAt: new Date(0),
        given: {},
        boundCidrs: { runtime: [], issuer: [], provisioner: [] },
        now,
      });
      const checks: Check[] = [];
      for (const id of DEPLOY_STORE_CHECKS) {
        const run = all[id];
        const answer: CheckAnswer =
          run === undefined
            ? { state: "unknown", observed: "no such check" }
            : await run().catch(() => ({ state: "unknown" as const, observed: "error" }));
        checks.push({ id, ...answer });
      }
      return checks;
    },
  });
}

export async function deployVerify(
  deps: DeployVerifyDeps,
  journey: JourneyResult | null,
): Promise<VerificationReport> {
  const all = storeChecks({
    ...deps,
    restoreStartedAt: new Date(0),
    given: {},
    boundCidrs: { runtime: [], issuer: [], provisioner: [] },
  });
  const answers: Record<string, CheckAnswer> = {};
  for (const id of DEPLOY_STORE_CHECKS) {
    const run = all[id];
    answers[id] =
      run === undefined
        ? { state: "unknown", observed: "no such check" }
        : await run().catch((error: unknown) => ({
            state: "unknown" as const,
            observed: error instanceof Error ? error.constructor.name : "error",
          }));
  }
  answers.previous_gate_closed = previousGateClosed(deps.previousGate);
  for (const [id, answer] of Object.entries(journey?.checks ?? {})) answers[id] = answer;
  // P-147 (c): a host with no secret has nothing to reveal, counted here, never assumed.
  const secrets = Number(
    (await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM app.secret_index")).rows[0]
      ?.n ?? "-1",
  );
  const none = revealCheckWithoutSecrets(secrets);
  if (none !== null) answers.journey_reveal_digest = none;
  const checks: Check[] = REQUIRED_CHECKS.deploy.map((id) => ({
    id,
    ...(answers[id] ?? { state: "unknown" as const, observed: "not performed" }),
  }));
  const members = Number(
    (await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM app.membership")).rows[0]?.n ??
      "0",
  );
  const report = verificationReportSchema.parse({
    format: "mykey-verification/1",
    host: deps.host,
    ...deps.expect,
    origin: deps.origin,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    checks,
    members,
  });
  await withTransaction(deps.pool, (tx) =>
    appendAudit(tx, {
      action: "operator.deploy",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details: { build: deps.expect.releaseBuild },
    }),
  );
  return report;
}
