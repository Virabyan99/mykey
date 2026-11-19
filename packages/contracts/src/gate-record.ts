// Run 6.7 (P-122, P-123, D-54): the gate record, version 2, and the
// verification report that alone may open it.
//
// The record binds the service to one host instance, one backend incarnation
// (the id written in three places: this record, app.service_control and
// OpenBao's mykey-meta/incarnation) and one release build. `phase` says whether
// the product is being verified (closed; only the private verification
// listener serves) or serving (open). A restore or a deploy writes a report;
// `gate open` refuses unless the report is of this host, incarnation and build,
// younger than 30 minutes, with every required check `ok`, and names its hash.
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const build = z.string().regex(/^[0-9a-f]{7,40}$/);

export const gateOriginSchema = z.union([
  z.strictObject({ kind: z.literal("fresh_install"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("restore"), pairId: z.uuid() }),
]);

export const gateRecordV2Schema = z.strictObject({
  version: z.literal(2),
  state: z.enum(["open", "closed"]),
  gateEpoch: z.int().nonnegative(),
  hostInstanceId: z.uuid(),
  backendIncarnation: z.uuid(),
  origin: gateOriginSchema,
  releaseBuild: build,
  reportSha256: sha256.nullable(),
  phase: z.enum(["verifying", "serving"]),
  writtenAt: z.iso.datetime(),
});

export type GateRecordV2 = z.infer<typeof gateRecordV2Schema>;

export const verificationCheckSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  state: z.enum(["ok", "failed", "unknown"]),
  /** What was seen: counts, ids and digests only, never a token or a value. */
  observed: z.string().max(2000),
});

export const verificationReportSchema = z.strictObject({
  format: z.literal("mykey-verification/1"),
  host: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  hostInstanceId: z.uuid(),
  backendIncarnation: z.uuid(),
  releaseBuild: build,
  origin: gateOriginSchema,
  createdAt: z.iso.datetime(),
  checks: z.array(verificationCheckSchema).max(100),
  /** Members (accounts with a membership) the operator must confirm after a restore. */
  members: z.int().nonnegative(),
});

export type VerificationReport = z.infer<typeof verificationReportSchema>;

/** The checks a report must hold, all `ok`, to open the gate (P-122, P-124, P-129). */
export const REQUIRED_CHECKS = {
  restore: [
    "pair_signature",
    "pair_digests",
    "schema_revision",
    "openbao_readable",
    "sessions_none",
    "accounts_recovery_pending",
    "reset_tokens_none",
    "machine_accessors_none",
    "credentials_all_revoked",
    "approle_secret_ids_rotated",
    "root_tokens_revoked",
    "control_row_idle",
    "incarnation_three_places",
    "operations_none_executing",
    "catalog_matches_backend",
    "members_confirmed",
    "journey_owner_enrolled",
    "journey_reveal_digest",
    "journey_mutation_refused",
    "old_credentials_refused",
  ],
  deploy: [
    "schema_revision",
    "openbao_readable",
    "incarnation_three_places",
    "control_row_idle",
    "journey_sign_in",
    "journey_reveal_digest",
    "journey_mutation_refused",
    "previous_gate_closed",
  ],
} as const satisfies Record<"restore" | "deploy", readonly string[]>;

/** A report older than this cannot open the gate. */
export const REPORT_MAX_AGE_MS = 30 * 60_000;
