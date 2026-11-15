// Import apply and resume (Run 4.7, P-77, Doc 06 §8 "Import", FR-1.36). An
// import is truthfully non-atomic: it is one parent operation (`import.apply`)
// whose entries are applied one at a time, each written entry a child of the
// mutation protocol (`runSecretAction` with `parent`), which takes and drops
// the environment's lock itself — the lock is free between entries.
//
// 1. Acceptance (one transaction, main pool): the parent executing under this
//    process; the caller's own unexpired, unclaimed preview of this
//    environment claimed; the file's HMAC under the preview's key equal to the
//    preview's; the entries copied; `import.apply` audited as intent. A refusal
//    rolls all of it back: no parent, the preview unclaimed.
// 2. The loop: the parent's heartbeat first (false: the sweep or another
//    executor has it — answer from the row), the budget after the first entry
//    (spent: awaiting_input, 202), then the next entry. `unchanged` and
//    `conflict` touch nothing; an `unchanged` entry is compared again with its
//    index row under the lock (M-2) and is `conflict` when the key moved;
//    `create` and `update` run as a child with the
//    preview's precondition and the key `<parent>:<ordinal>`, so a resumed
//    entry replays its child instead of writing twice.
// 3. An unknown child outcome stops the import: the entry and the parent
//    uncertain, 503 outcome_unknown with the parent's id. It is settled
//    through the child (reconcile-operation), never resumed.
// 4. No entry left: succeeded when every outcome is created, updated or
//    unchanged, partial otherwise, with the outcomes as the result.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AuditUnavailable, appendAudit } from "@mykey/audit";
import {
  LIMITS,
  parseDotenv,
  type ErrorCode,
  type OperationId,
  type UserId,
} from "@mykey/contracts";
import {
  claimPreview,
  claimResume,
  environmentCounters,
  fileOfParent,
  findOperation,
  findOperationByKey,
  finishOperation,
  importResult,
  insertImportEntries,
  insertOperation,
  nextImportEntry,
  readIndexRow,
  recordImportOutcome,
  slotOf,
  touchOperation,
  type EntryOutcome,
  type EnvironmentScope,
  type ImportResult,
  type OperationRow,
  type PendingEntry,
} from "@mykey/db";
import type pg from "pg";
import { intentFingerprint, sameIntent, type Intent } from "../replay.ts";
import type { Refused } from "../secrets/history.ts";
import {
  onMainPool,
  runSecretAction,
  type EffectDeps,
  type SecretOutcome,
} from "../secrets/protocol.ts";
import { Busy, withEnvironmentLock } from "../secrets/lock.ts";
import { fileHmac } from "./preview.ts";

export const IMPORT_ACTION = "import.apply";

export type ImportOutcome =
  | { kind: "finished" | "waiting" | "replay"; operation: OperationRow }
  | Refused
  | { kind: "unknown"; operationId: OperationId };

interface Common {
  scope: EnvironmentScope;
  userId: UserId;
  bytes: Uint8Array;
  requestId: string;
  /** How long this request may apply entries (after the first one) before it answers 202. */
  budgetMs: number;
  /** The admission recheck of every child (FR-1.10); also run at acceptance. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export interface ApplyRequest extends Common {
  previewId: string;
  idempotencyKey: string;
  intent: Intent;
}

export interface ResumeRequest extends Common {
  operationId: OperationId;
}

const refused = (code: ErrorCode, operationId?: OperationId): Refused => ({
  kind: "refused",
  code,
  ...(operationId === undefined ? {} : { operationId }),
});

class Refusal extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.outcome = outcome;
  }
}

const sameMac = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** The file's values by name; the bytes were previewed, so they parse. */
function valuesOf(bytes: Uint8Array): Map<string, string> {
  const parsed = parseDotenv(bytes);
  if (!parsed.ok) throw new Error("an accepted import file no longer parses");
  return new Map(parsed.entries.map((entry) => [entry.name, entry.value]));
}

function auditImport(
  db: pg.PoolClient,
  run: { scope: EnvironmentScope; userId: UserId; requestId: string },
  operationId: OperationId,
  outcome: "intent" | "success" | "unknown",
  details: Record<string, number>,
): Promise<string> {
  return appendAudit(db, {
    action: "import.apply",
    actor: { kind: "user", id: run.userId },
    source: "api",
    organizationId: run.scope.organizationId,
    target: { kind: "environment", id: run.scope.environmentId },
    outcome,
    requestId: run.requestId,
    operationId,
    details,
  });
}

export async function applyImport(deps: EffectDeps, request: ApplyRequest): Promise<ImportOutcome> {
  const started = performance.now();
  const { scope } = request;
  const parentId = randomUUID() as OperationId;
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: IMPORT_ACTION,
    target: scope.environmentId,
    idempotencyKey: request.idempotencyKey,
  };
  let accepted: { replay: OperationRow } | { entries: number };
  try {
    accepted = await onMainPool(deps.pool, async (tx) => {
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: parentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        state: "executing",
        executorBootId: deps.bootId,
        fingerprint: digest,
        fingerprintKeyId: keyId,
        result: null,
      });
      if (inserted === "exists") {
        const found = await findOperationByKey(tx, key);
        if (found === null) throw new Error("operation key exists but its row was not found");
        if (!sameIntent(deps.ring, found, request.intent)) {
          throw new Refusal(refused("idempotency_conflict"));
        }
        return { replay: found };
      }
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(refused(code));
      const claim = await claimPreview(tx, request.previewId, scope, request.userId, parentId);
      if (claim.kind === "absent") throw new Refusal(refused("not_found"));
      if (claim.kind !== "claimed") throw new Refusal(refused("state_conflict"));
      // A preview made under a fingerprint key that has since left the ring cannot be applied.
      if (deps.ring.keys[claim.hmacKeyId] === undefined) {
        throw new Refusal(refused("state_conflict"));
      }
      if (!sameMac(fileHmac(deps.ring, request.bytes, claim.hmacKeyId).mac, claim.fileHmac)) {
        throw new Refusal(refused("validation_failed"));
      }
      await insertImportEntries(tx, parentId, claim.entries);
      await auditImport(tx, request, parentId, "intent", { entries: claim.entries.length });
      return { entries: claim.entries.length };
    });
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    if (error instanceof AuditUnavailable) return refused("audit_unavailable");
    throw error;
  }
  if ("replay" in accepted) return { kind: "replay", operation: accepted.replay };
  return runEntries(deps, request, parentId, valuesOf(request.bytes), started);
}

/**
 * Resume of an import that waits for its owner (Task C): the caller's own
 * parent in this environment, the same file, then the loop of apply.
 * Entries keep the preconditions of the preview: what changed in between
 * becomes `conflict`.
 */
export async function resumeImport(
  deps: EffectDeps,
  request: ResumeRequest,
): Promise<ImportOutcome> {
  const started = performance.now();
  const { scope } = request;
  const row = await findOperation(deps.pool, request.operationId);
  if (
    row?.action !== IMPORT_ACTION ||
    row.principalKind !== "user" ||
    row.principalId !== request.userId ||
    row.environmentId !== scope.environmentId ||
    row.organizationId !== scope.organizationId
  ) {
    return refused("not_found");
  }
  if (row.state === "accepted" || row.state === "executing")
    return { kind: "waiting", operation: row };
  if (row.state === "uncertain") return { kind: "unknown", operationId: row.id };
  if (row.state !== "awaiting_input") return refused("state_conflict");
  const file = await fileOfParent(deps.pool, row.id);
  if (file === null || deps.ring.keys[file.hmacKeyId] === undefined) {
    return refused("state_conflict");
  }
  if (!sameMac(fileHmac(deps.ring, request.bytes, file.hmacKeyId).mac, file.fileHmac)) {
    return refused("validation_failed");
  }
  if (!(await claimResume(deps.pool, row.id, deps.bootId))) {
    const now = await findOperation(deps.pool, row.id);
    return now === null ? refused("not_found") : { kind: "waiting", operation: now };
  }
  return runEntries(deps, request, row.id, valuesOf(request.bytes), started);
}

/** What one entry came to. */
type Step =
  | { kind: "outcome"; outcome: EntryOutcome; childId: OperationId | null }
  | { kind: "uncertain"; childId: OperationId }
  | { kind: "wait" };

/** A child's refusal that means the entry's key no longer matches the preview. */
const CONFLICTS: ReadonlySet<ErrorCode> = new Set([
  "version_conflict",
  "already_exists",
  "state_conflict",
  "not_found",
]);

/**
 * The entries of an accepted parent. Once the parent is accepted, entries may
 * have changed secrets: any failure here (PostgreSQL gone, a child's throw)
 * answers outcome_unknown with the parent's id, never a bare refusal (gate
 * review I-2). The parent stays executing; the sweep moves it truthfully.
 */
async function runEntries(
  deps: EffectDeps,
  run: Common,
  parentId: OperationId,
  values: Map<string, string>,
  started: number,
): Promise<ImportOutcome> {
  try {
    return await runEntriesOf(deps, run, parentId, values, started);
  } catch {
    return { kind: "unknown", operationId: parentId };
  }
}

async function runEntriesOf(
  deps: EffectDeps,
  run: Common,
  parentId: OperationId,
  values: Map<string, string>,
  started: number,
): Promise<ImportOutcome> {
  const fromRow = async (): Promise<ImportOutcome> => {
    const row = await findOperation(deps.pool, parentId);
    return row === null
      ? { kind: "unknown", operationId: parentId }
      : { kind: "replay", operation: row };
  };
  let applied = 0;
  for (;;) {
    if (applied > 0) await deps.faults?.("between_entries", parentId);
    if (!(await touchOperation(deps.pool, parentId, deps.bootId))) return fromRow();
    const entry = await nextImportEntry(deps.pool, parentId);
    if (entry === null) break;
    if (applied > 0 && performance.now() - started > run.budgetMs) {
      return park(deps, parentId, fromRow);
    }
    const step = await applyEntry(deps, run, parentId, entry, values);
    if (step.kind === "wait") return park(deps, parentId, fromRow);
    if (step.kind === "uncertain") {
      await recordImportOutcome(deps.pool, parentId, entry.ordinal, "uncertain", step.childId);
      const stopped = await onMainPool(deps.pool, async (tx) => {
        const row = await finishOperation(tx, parentId, deps.bootId, { state: "uncertain" }, 0);
        if (row !== null) {
          await auditImport(
            tx,
            run,
            parentId,
            "unknown",
            (await importResult(tx, parentId)).counts,
          );
        }
        return row;
      }).catch(() => null);
      return stopped === null ? fromRow() : { kind: "unknown", operationId: parentId };
    }
    await recordImportOutcome(deps.pool, parentId, entry.ordinal, step.outcome, step.childId);
    applied += 1;
  }

  await deps.faults?.("before_import_finish", parentId);
  const finished = await onMainPool(deps.pool, async (tx) => {
    const result = await importResult(tx, parentId);
    const row = await finishOperation(
      tx,
      parentId,
      deps.bootId,
      { state: allApplied(result) ? "succeeded" : "partial", result: { ...result } },
      LIMITS.operation.terminalRetentionDays,
    );
    if (row !== null) await auditImport(tx, run, parentId, "success", result.counts);
    return row;
  });
  return finished === null ? fromRow() : { kind: "finished", operation: finished };
}

/** Succeeded: every outcome is created, updated or unchanged. */
export function allApplied(result: ImportResult): boolean {
  return result.entries.every(
    (entry) =>
      entry.outcome === "created" || entry.outcome === "updated" || entry.outcome === "unchanged",
  );
}

/** The parent waits for its owner (awaiting_input); answered 202. */
async function park(
  deps: EffectDeps,
  parentId: OperationId,
  fromRow: () => Promise<ImportOutcome>,
): Promise<ImportOutcome> {
  const row = await onMainPool(deps.pool, (tx) =>
    finishOperation(tx, parentId, deps.bootId, { state: "awaiting_input" }, 0),
  );
  return row === null ? fromRow() : { kind: "waiting", operation: row };
}

async function applyEntry(
  deps: EffectDeps,
  run: Common,
  parentId: OperationId,
  entry: PendingEntry,
  values: Map<string, string>,
): Promise<Step> {
  if (entry.classification === "unchanged") return recheckUnchanged(deps, run, entry);
  if (entry.classification !== "create" && entry.classification !== "update") {
    // conflict (an invalid or duplicate entry never reaches an accepted import).
    return { kind: "outcome", outcome: "conflict", childId: null };
  }
  const value = values.get(entry.name);
  if (value === undefined) throw new Error("an entry of the import is not in its file");
  const action = entry.classification;
  const routeId = action === "create" ? "secrets.create" : "secrets.update";
  const expected =
    action === "update" && entry.expectedVersion !== null && entry.expectedStateTag !== null
      ? { version: entry.expectedVersion, stateTag: entry.expectedStateTag }
      : undefined;
  // Whether the child's refusal came from the recheck (authority or a state) rather than the key.
  let recheckRefused = false;
  const outcome = await runSecretAction(deps, {
    action,
    routeId,
    scope: run.scope,
    userId: run.userId,
    name: entry.name,
    value,
    ...(expected === undefined ? {} : { expected }),
    idempotencyKey: `${parentId}:${String(entry.ordinal)}`,
    intent: {
      principalKind: "user",
      principalId: run.userId,
      action: routeId,
      target: run.scope.environmentId,
      body: {
        name: entry.name,
        value,
        ...(expected === undefined
          ? {}
          : { expectedVersion: expected.version, expectedStateTag: expected.stateTag }),
      },
    },
    requestId: run.requestId,
    parent: { operationId: parentId, ordinal: entry.ordinal },
    recheck: async (tx) => {
      const code = await run.recheck(tx);
      if (code !== null) recheckRefused = true;
      return code;
    },
  });
  const written: EntryOutcome = action === "create" ? "created" : "updated";
  return stepOf(deps, outcome, entry.name, written, () => recheckRefused);
}

/**
 * M-2 (P-103, FR-1.36 "Recheck even unchanged entries"): under the
 * environment's lock, the key must still be live at the version and state tag
 * of the preview, and no secret action may hold it. Otherwise it moved: the
 * entry is `conflict`, as a changed `update` entry is. The lock not had in
 * time: the entry waits for a resume.
 */
async function recheckUnchanged(deps: EffectDeps, run: Common, entry: PendingEntry): Promise<Step> {
  const { lockKey } = await environmentCounters(deps.pool, run.scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, async (locked) => {
      const row = await readIndexRow(locked.client, run.scope, entry.name);
      const slot = await slotOf(locked.client, run.scope);
      const same =
        row?.state === "live" &&
        row.currentVersion === entry.expectedVersion &&
        row.stateTag === entry.expectedStateTag &&
        slot?.secretName !== entry.name;
      return { kind: "outcome", outcome: same ? "unchanged" : "conflict", childId: null };
    });
  } catch (error) {
    if (error instanceof Busy) return { kind: "wait" };
    throw error;
  }
}

async function stepOf(
  deps: EffectDeps,
  outcome: SecretOutcome,
  name: string,
  written: EntryOutcome,
  recheckRefused: () => boolean,
): Promise<Step> {
  switch (outcome.kind) {
    case "succeeded":
      return { kind: "outcome", outcome: written, childId: outcome.operation.id };
    case "unknown":
      return { kind: "uncertain", childId: outcome.operationId };
    case "replay": {
      const child = outcome.operation;
      if (child.state === "succeeded")
        return { kind: "outcome", outcome: written, childId: child.id };
      if (child.state === "rejected")
        return refusalStep(
          deps,
          (child.errorCode ?? "dependency_unavailable") as ErrorCode,
          child.id,
          name,
          true,
        );
      return { kind: "uncertain", childId: child.id };
    }
    case "refused":
      if (recheckRefused()) return { kind: "wait" };
      return refusalStep(deps, outcome.code, outcome.operationId, name, false);
  }
}

/**
 * A child refused: the key moved since the preview → conflict; over capacity →
 * rejected; a child that was admitted and then rejected → rejected (its key
 * would only replay that rejection); anything else before admission (busy, the
 * slot of another key, a sealed or unreachable backend, the gate) leaves the
 * entry for a resume.
 */
async function refusalStep(
  deps: EffectDeps,
  code: ErrorCode,
  operationId: OperationId | undefined,
  name: string,
  admitted: boolean,
): Promise<Step> {
  if (CONFLICTS.has(code)) return { kind: "outcome", outcome: "conflict", childId: null };
  if (code === "capacity_exceeded") return { kind: "outcome", outcome: "rejected", childId: null };
  if (code === "key_under_review") {
    // No holder: the key itself is in review. A holder acting on this key: the key moved.
    if (operationId === undefined) return { kind: "outcome", outcome: "conflict", childId: null };
    const holder = await findOperation(deps.pool, operationId);
    return holder?.secretName === name
      ? { kind: "outcome", outcome: "conflict", childId: null }
      : { kind: "wait" };
  }
  // A refusal after admission carries the child's id: the child is terminal (rejected).
  if (admitted || operationId !== undefined) {
    return { kind: "outcome", outcome: "rejected", childId: operationId ?? null };
  }
  return { kind: "wait" };
}
