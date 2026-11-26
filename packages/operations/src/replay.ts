// Replay identity of a mutation (Run 3.9, P-58, Doc 06 §6.2). The operation's
// unique key is who (principal) did what (action) on which target with which
// Idempotency-Key; its fingerprint is an HMAC of the whole intent, body
// included, so the same key with another body is a conflict, never a replay.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  EnvironmentId,
  ErrorCode,
  OperationId,
  OperationResponse,
  OrganizationId,
  ProjectId,
  RouteDef,
} from "@mykey/contracts";
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
  /**
   * The path parameters other than org, project and env (P-64): `name`,
   * `preview`, `operation`, `credential`. In the canonical text only when there
   * is at least one, so fingerprints stored before Run 4.1 still match.
   */
  params?: Record<string, string>;
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
  const params =
    intent.params !== undefined && Object.keys(intent.params).length > 0
      ? intent.params
      : undefined;
  const text = canonical({
    principalKind: intent.principalKind,
    principalId: intent.principalId,
    action: intent.action,
    target: intent.target,
    params,
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
  input: OperationKey & {
    organizationId: OrganizationId;
    /** The scope the operation acts in (P-63): who may read its status follows from it. */
    projectId?: ProjectId;
    environmentId?: EnvironmentId;
    body: unknown;
    params?: Record<string, string>;
  },
): Promise<Begin> {
  const { body, organizationId, params, projectId, environmentId, ...key } = input;
  const intent = { ...key, body, ...(params === undefined ? {} : { params }) };
  const { digest, keyId } = intentFingerprint(ring, intent);
  const id = randomUUID() as OperationId;
  const inserted = await insertOperation(tx, {
    ...key,
    id,
    organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(environmentId === undefined ? {} : { environmentId }),
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

/**
 * The operation envelope of the contract; never the fingerprint. A rejected
 * operation carries its error code as its result; an uncertain one none.
 */
export function operationResponse(row: OperationRow): OperationResponse {
  const result =
    row.state === "rejected"
      ? { errorCode: row.errorCode }
      : row.state === "uncertain"
        ? null
        : row.result;
  return {
    operationId: row.id,
    state: row.state,
    statusUrl: `/v1/operations/${row.id}`,
    replayExpiresAt: row.replayExpiresAt === null ? null : row.replayExpiresAt.toISOString(),
    ...(result === null ? {} : { result }),
  };
}

export type ReplayAnswer =
  | { status: 200 | 201 | 202; body: OperationResponse }
  | { error: ErrorCode; operationId?: OperationId };

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "partial", "rejected"]);

/** The issuances whose answer holds a secret that is shown once. */
const SHOWN_ONCE: ReadonlySet<string> = new Set([
  "credentials.issue",
  "runtime_credentials.issue",
  "automation.runtime_credentials.issue",
  // Run 11.5: nor does an automation credential's issuance show its secret again.
  "automation_credentials.issue",
]);

/**
 * The answer to a request whose operation already exists (P-65): unfinished →
 * 202 with the envelope; succeeded → the route's completed status; partial →
 * 200; rejected → its stored error; uncertain → outcome_unknown; a terminal
 * row past its replay expiry → replay_expired. Unfinished rows never expire.
 */
export function replayAnswer(route: RouteDef, row: OperationRow): ReplayAnswer {
  if (TERMINAL.has(row.state) && row.expired) {
    return { error: "replay_expired", operationId: row.id };
  }
  switch (row.state) {
    case "accepted":
    case "executing":
    case "awaiting_input":
      return { status: 202, body: operationResponse(row) };
    case "succeeded":
      // P-88 (FR-1.43): a token is shown once; a replayed issuance never shows it again.
      // Session 11: nor does one of a runtime credential show its client secret again.
      if (SHOWN_ONCE.has(route.id)) {
        return { error: "credential_not_replayable", operationId: row.id };
      }
      return { status: 201 in route.responses ? 201 : 200, body: operationResponse(row) };
    case "partial":
      return { status: 200, body: operationResponse(row) };
    case "rejected":
      return {
        error: (row.errorCode ?? "dependency_unavailable") as ErrorCode,
        operationId: row.id,
      };
    case "uncertain":
      return { error: "outcome_unknown", operationId: row.id };
  }
}
