// Import preview (Run 4.7, P-76, Doc 06 §8 "Import", FR-1.35). The file is
// parsed first: a file the parser refuses answers its issues and stores
// nothing. Then, under the environment's lock on the lock's connection: the
// caller's access and the states re-read, the slot, the index rows of the
// file's names and the counters; when the caller may read, the current value
// of every live name, eight at a time, compared with the file's value in
// memory only; the classification; the capacity the import would reach; and
// one transaction that stores the preview and its audit row. The stored row
// and the answer hold names, lines, classifications, versions and tags only.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AuditUnavailable, appendAudit } from "@mykey/audit";
import {
  LIMITS,
  loaderWarnings,
  parseDotenv,
  type DotenvRule,
  type ErrorCode,
  type UserId,
} from "@mykey/contracts";
import {
  environmentCounters,
  indexRowsOf,
  insertPreview,
  markKeyReview,
  slotOf,
  type EnvironmentScope,
} from "@mykey/db";
import { secretPath } from "@mykey/openbao";
import type pg from "pg";
import type { HmacRing } from "../replay.ts";
import type { ReadDeps, Refused } from "../secrets/history.ts";
import { Busy, inTransaction, withEnvironmentLock } from "../secrets/lock.ts";
import { backendRefusal } from "../secrets/protocol.ts";
import { classifyEntries, type Classification } from "./classify.ts";

/** HMAC-SHA-256(key, "import-file" ‖ 0x00 ‖ bytes) under `keyId` (default: the ring's current key). */
export function fileHmac(
  ring: HmacRing,
  bytes: Uint8Array,
  keyId: string = ring.current,
): { mac: Buffer; keyId: string } {
  const key = ring.keys[keyId];
  if (key === undefined) throw new Error(`unknown file key id ${keyId}`);
  const mac = createHmac("sha256", Buffer.from(key))
    .update("import-file")
    .update(Buffer.from([0]))
    .update(bytes)
    .digest();
  return { mac, keyId };
}

export interface ImportPreviewBody {
  previewId: string | null;
  expiresAt: string | null;
  applicable: boolean;
  counts: Record<Classification, number>;
  entries: { ordinal: number; line: number; name: string | null; classification: Classification }[];
  issues: { line: number; rule: DotenvRule }[];
  warnings: { name: string; loader: "nextjs" | "python-dotenv"; kind: "expansion" | "escape" }[];
}

export interface PreviewRequest {
  scope: EnvironmentScope;
  userId: UserId;
  /** The caller may read values (`decide` for secrets.read): only then can an entry be `unchanged`. */
  mayRead: boolean;
  bytes: Uint8Array;
  requestId: string;
  /** The admission recheck (FR-1.10), as for a reveal: null when the caller may still write. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type PreviewOutcome = { kind: "ok"; body: ImportPreviewBody } | Refused;

/** Values of live names read at once (Doc 06 §8: eight at a time). */
const READ_BATCH = 8;

const refused = (code: ErrorCode, details?: Record<string, unknown>): Refused => ({
  kind: "refused",
  code,
  ...(details === undefined ? {} : { details }),
});

class Stop extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.outcome = outcome;
  }
}

const zeroCounts = (): Record<Classification, number> => ({
  create: 0,
  update: 0,
  unchanged: 0,
  conflict: 0,
  invalid: 0,
  duplicate: 0,
});

/** Constant-time equality of two values; their lengths are compared first. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export async function previewImport(
  deps: ReadDeps & { ring: HmacRing },
  request: PreviewRequest,
): Promise<PreviewOutcome> {
  const { scope } = request;
  const notApplicable = (issues: ImportPreviewBody["issues"]): PreviewOutcome => ({
    kind: "ok",
    body: {
      previewId: null,
      expiresAt: null,
      applicable: false,
      counts: zeroCounts(),
      entries: [],
      issues,
      warnings: [],
    },
  });
  const parsed = parseDotenv(request.bytes);
  if (!parsed.ok) return notApplicable(parsed.issues.map(({ line, rule }) => ({ line, rule })));
  if (parsed.entries.length === 0) return notApplicable([]);
  const entries = parsed.entries;
  const warnings = loaderWarnings(entries).map(({ name, loader, reason }) => ({
    name,
    loader,
    kind: reason,
  }));

  const bao = deps.bao.clientFor(scope.organizationId);
  if (bao === null) return refused("dependency_unavailable");
  const { lockKey } = await environmentCounters(deps.pool, scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, async (locked) => {
      // (1) Access, slot, rows and counters.
      const seen = await inTransaction(locked.client, async (tx) => {
        const code = await request.recheck(tx);
        if (code !== null) throw new Stop(refused(code));
        const slot = await slotOf(tx, scope);
        // Only a secret action holds a slot, and it names its key.
        if (slot !== null && slot.secretName === null) throw new Stop(refused("busy"));
        const rows = await indexRowsOf(
          tx,
          scope,
          entries.map((entry) => entry.name),
        );
        const counters = await environmentCounters(tx, scope);
        return { slotName: slot?.secretName ?? null, rows, counters };
      });
      const { slotName, rows, counters } = seen;

      // (2) The current values of the live names, compared in memory only.
      let equal: Set<string> | null = null;
      if (request.mayRead) {
        equal = new Set();
        const live = entries.filter(
          (entry) => rows.get(entry.name)?.state === "live" && entry.name !== slotName,
        );
        for (let start = 0; start < live.length; start += READ_BATCH) {
          const batch = live.slice(start, start + READ_BATCH);
          const reads = await Promise.all(
            batch.map((entry) =>
              bao.kvRead(secretPath(scope.projectId, scope.environmentId, entry.name)),
            ),
          );
          for (const [position, entry] of batch.entries()) {
            const read = reads[position];
            const row = rows.get(entry.name);
            if (read === undefined || row === undefined) throw new Error("read batch out of step");
            if (!read.ok) {
              if (read.kind === "not_found" || (read.kind === "invalid" && read.status === 200)) {
                await markKeyReview(deps.pool, scope, entry.name, null);
                return refused("backend_inconsistent");
              }
              return refused(await backendRefusal(deps.pool, scope, read, request.requestId));
            }
            if (read.data.version !== row.currentVersion) {
              await markKeyReview(deps.pool, scope, entry.name, null);
              return refused("backend_inconsistent");
            }
            if (sameText(read.data.envelope.value, entry.value)) equal.add(entry.name);
          }
        }
      }
      await deps.faults?.("after_backend_read");

      // (3) Classification and capacity.
      const same = equal;
      const classified = classifyEntries(
        entries,
        rows,
        same === null ? null : (name) => same.has(name),
        slotName,
      );
      const counts = zeroCounts();
      for (const entry of classified) counts[entry.classification] += 1;
      const answer = {
        counts,
        entries: classified.map(({ ordinal, line, name, classification }) => ({
          ordinal,
          line,
          name,
          classification,
        })),
        issues: [],
        warnings,
      };
      if (counts.invalid > 0 || counts.duplicate > 0) {
        return {
          kind: "ok",
          body: { previewId: null, expiresAt: null, applicable: false, ...answer },
        };
      }
      let names = counters.names;
      let liveBytes = counters.liveBytes;
      for (const entry of classified) {
        const value = entries[entry.ordinal - 1]?.value ?? "";
        if (entry.classification === "create") {
          names += 1;
          liveBytes += byteLength(value);
        } else if (entry.classification === "update") {
          liveBytes += byteLength(value) - (rows.get(entry.name ?? "")?.liveValueBytes ?? 0);
        }
      }
      if (names > LIMITS.environment.maxNames) {
        return refused("capacity_exceeded", { limit: "names" });
      }
      if (liveBytes > LIMITS.environment.maxLiveValueBytes) {
        return refused("capacity_exceeded", { limit: "bytes" });
      }

      // (4) The preview and its audit row, in one transaction.
      const previewId = randomUUID();
      const { mac, keyId } = fileHmac(deps.ring, request.bytes);
      const expiresAt = await inTransaction(locked.client, async (tx) => {
        const at = await insertPreview(tx, {
          id: previewId,
          scope,
          ownerUserId: request.userId,
          fileHmac: mac,
          hmacKeyId: keyId,
          entries: classified,
          ttlSeconds: LIMITS.importPreview.ttlSeconds,
        });
        await appendAudit(tx, {
          action: "import.preview",
          actor: { kind: "user", id: request.userId },
          source: "api",
          organizationId: scope.organizationId,
          target: { kind: "environment", id: scope.environmentId },
          outcome: "success",
          requestId: request.requestId,
          operationId: null,
          details: { entries: classified.length },
        });
        return at;
      }).catch((error: unknown) => {
        if (error instanceof AuditUnavailable) throw new Stop(refused("dependency_unavailable"));
        throw error;
      });
      return {
        kind: "ok",
        body: { previewId, expiresAt: expiresAt.toISOString(), applicable: true, ...answer },
      };
    });
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}
