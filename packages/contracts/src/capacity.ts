// Disk pressure (Run 6.3, P-115, FR-1.61, AC-1.24, D-49). The host measures
// its filesystems every minute (infra/hosts/checks/status.sh) and writes this
// record into the gate directory; the API reads it afresh per mutation. The
// API cannot see another container's volume; the host can.
import { z } from "zod";
import { LIMITS } from "./limits.ts";

const volumeSchema = z.strictObject({
  freeBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().positive(),
  freeInodesPercent: z.number().min(0).max(100),
});

export interface CapacityRecord {
  version: 1;
  observedAt: string;
  state: "ok" | "low";
  volumes: Record<string, { freeBytes: number; sizeBytes: number; freeInodesPercent: number }>;
}

export const capacityRecordSchema: z.ZodType<CapacityRecord> = z.strictObject({
  version: z.literal(1),
  observedAt: z.iso.datetime(),
  state: z.enum(["ok", "low"]),
  volumes: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), volumeSchema),
});

/**
 * `low` when a volume has free bytes under `minFreeBytesPercent` of its size,
 * or under `minFreeBytes + auditReserveBytes`, or free inodes under
 * `minFreeInodesPercent`. No volume at all is not `ok`.
 */
export function capacityState(volumes: CapacityRecord["volumes"]): "ok" | "low" {
  const entries = Object.values(volumes);
  if (entries.length === 0) return "low";
  const { minFreeBytesPercent, minFreeBytes, auditReserveBytes, minFreeInodesPercent } =
    LIMITS.disk;
  for (const volume of entries) {
    if (volume.freeBytes * 100 < volume.sizeBytes * minFreeBytesPercent) return "low";
    if (volume.freeBytes < minFreeBytes + auditReserveBytes) return "low";
    if (volume.freeInodesPercent < minFreeInodesPercent) return "low";
  }
  return "ok";
}

/**
 * The mutations that grow what is stored: under `low` they are 507
 * capacity_exceeded { limit: "disk" }; with no usable record, 503. Contract
 * route ids, and the auth module's writing paths as `POST /v1/auth/<path>`.
 */
export const EXPANDING_ROUTES: ReadonlySet<string> = new Set([
  "projects.create",
  "projects.rename",
  "projects.reactivate",
  "environments.create",
  "environments.rename",
  "environments.reactivate",
  "secrets.create",
  "secrets.update",
  "secrets.delete",
  "secrets.undelete",
  "secrets.restore",
  "import.preview",
  "import.apply",
  "import.resume",
  "credentials.issue",
  // Session 11: each of these stores a new row.
  "runtime_credentials.issue",
  "automation_credentials.issue",
  "automation.projects.create",
  "automation.environments.create",
  "automation.secrets.create",
  "automation.runtime_credentials.issue",
  "auth.reset.complete",
  "POST /v1/auth/change-password",
  "POST /v1/auth/totp/enroll",
  "POST /v1/auth/totp/activate",
  "POST /v1/auth/recovery/regenerate",
]);

/**
 * The mutations that continue under `low` and without a record: those that
 * reduce exposure, and sign-in with its factors, without which nobody could
 * reach them.
 */
export const REDUCING_ROUTES: ReadonlySet<string> = new Set([
  "projects.archive",
  "environments.archive",
  "credentials.revoke",
  // Session 11.
  "automation_credentials.revoke",
  "automation.runtime_credentials.revoke",
  "POST /v1/auth/sign-in/email",
  "POST /v1/auth/sign-out",
  "POST /v1/auth/sessions/revoke",
  "POST /v1/auth/revoke-sessions",
  "POST /v1/auth/totp/verify",
  "POST /v1/auth/recovery/verify",
  "POST /v1/auth/totp/step-up",
]);

/**
 * P-118: the mutations that continue while a pair is captured (the mode is
 * `draining` or `capturing`): those that only read and audit, and those that
 * reduce access, which record an invalidation instead. Every other route and
 * auth path that is not a GET answers 503 busy.
 */
export const CAPTURE_OPEN_ROUTES: ReadonlySet<string> = new Set([
  "secrets.reveal",
  "export.create",
  "machine.resolve",
  "projects.archive",
  "environments.archive",
  "credentials.revoke",
  // Session 11: a server that restarts at 03:00 UTC must still get its token
  // (the exchange reads and audits, as machine.resolve does); and the two
  // revocations reduce access.
  "machine.exchange",
  "automation_credentials.revoke",
  "automation.runtime_credentials.revoke",
  "POST /v1/auth/sign-out",
  "POST /v1/auth/sessions/revoke",
  "POST /v1/auth/revoke-sessions",
]);

/** True for a request the capture barrier refuses at admission. */
export function closedByCapture(id: string, method: string): boolean {
  return method !== "GET" && !CAPTURE_OPEN_ROUTES.has(id);
}
