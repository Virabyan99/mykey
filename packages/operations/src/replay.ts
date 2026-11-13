// Replay identity of a mutation (Run 3.9, P-58, Doc 06 §6.2). The operation's
// unique key is who (principal) did what (action) on which target with which
// Idempotency-Key; its fingerprint is an HMAC of the whole intent, body
// included, so the same key with another body is a conflict, never a replay.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { OperationId, OperationResponse, OrganizationId } from "@mykey/contracts";
import {
  findOperationByKey,
  insertOperation,
  type OperationKey,
  type OperationRow,
} from "@mykey/db";
import type pg from "pg";

/** A key ring as @mykey/auth loads it (the same shape; declared here so the provisioner never imports auth). */
export interface HmacRing {
  current: string;
  keys: Readonly<Record<string, Uint8Array>>;
}

export interface Intent {
  principalKind: string;
  principalId: string;
  action: string;
  target: string;
  body: unknown;
}

/** Sorted keys, NFC strings, no whitespace. */
function canonical(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .map(([key, inner]) => [key.normalize("NFC"), inner] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** HMAC-SHA-256 of the canonical intent under `keyId` (default: the ring's current key). */
export function intentFingerprint(
  ring: HmacRing,
  intent: Intent,
  keyId: string = ring.current,
): { digest: Buffer; keyId: string } {
  const key = ring.keys[keyId];
  if (key === undefined) throw new Error(`unknown fingerprint key id ${keyId}`);
  const text = canonical({
    principalKind: intent.principalKind,
    principalId: intent.principalId,
    action: intent.action,
    target: intent.target,
    body: intent.body,
  });
  return { digest: createHmac("sha256", Buffer.from(key)).update(text).digest(), keyId };
}

/** Whether a stored operation was made from this intent (under its own key id). */
export function sameIntent(ring: HmacRing, row: OperationRow, intent: Intent): boolean {
  if (row.fingerprint === null || row.fingerprintKeyId === null) return false;
  if (ring.keys[row.fingerprintKeyId] === undefined) return false;
  const { digest } = intentFingerprint(ring, intent, row.fingerprintKeyId);
  return digest.length === row.fingerprint.length && timingSafeEqual(digest, row.fingerprint);
}

export type Begin =
  | { kind: "fresh"; operationId: OperationId }
  | { kind: "replay"; operation: OperationRow }
  | { kind: "conflict" };

/**
 * Inserts the operation, or finds the one with the same key. The insert waits
 * for a concurrent first request with the same key: if that one commits, this
 * one finds it (replay or conflict); if it rolls back, this one is fresh.
 */
export async function beginOperation(
  tx: pg.PoolClient,
  ring: HmacRing,
  input: OperationKey & { organizationId: OrganizationId; body: unknown },
): Promise<Begin> {
  const { body, organizationId, ...key } = input;
  const intent = { ...key, body };
  const { digest, keyId } = intentFingerprint(ring, intent);
  const id = randomUUID() as OperationId;
  const inserted = await insertOperation(tx, {
    ...key,
    id,
    organizationId,
    state: "executing",
    fingerprint: digest,
    fingerprintKeyId: keyId,
    result: null,
  });
  if (inserted === "inserted") return { kind: "fresh", operationId: id };
  const found = await findOperationByKey(tx, key);
  if (found === null) throw new Error("operation key exists but its row was not found");
  return sameIntent(ring, found, intent)
    ? { kind: "replay", operation: found }
    : { kind: "conflict" };
}

/** The operation envelope of the contract; never the fingerprint. */
export function operationResponse(row: OperationRow): OperationResponse {
  return {
    operationId: row.id,
    state: row.state,
    statusUrl: `/v1/operations/${row.id}`,
    replayExpiresAt: row.replayExpiresAt === null ? null : row.replayExpiresAt.toISOString(),
    ...(row.result === null ? {} : { result: row.result }),
  };
}
