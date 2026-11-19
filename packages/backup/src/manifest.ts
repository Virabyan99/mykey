// Run 6.5 (P-119, D-52): the pair, format mykey-pair/1. One PostgreSQL dump,
// the database globals and one OpenBao Raft snapshot taken at one boundary;
// the manifest names them with their sizes and digests. Nothing in it is a
// secret: the backup password is named by reference (`<host>/<n>`).
//
// A pair exists for a restore only once `eligible.json` (an Eligibility,
// signed by the host's key) sits beside its bundle.
import { z } from "zod";

export const PAIR_FORMAT = "mykey-pair/1";
export const ARTIFACT_NAMES = ["postgres.dump", "globals.sql", "openbao.snap"] as const;
export type ArtifactName = (typeof ARTIFACT_NAMES)[number];
/** How long a verified pair may be restored from (the bucket's lock is as long). */
export const ELIGIBLE_DAYS = 30;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const instant = z.iso.datetime();
const host = z.string().regex(/^[a-z][a-z0-9-]*$/);

const artifactSchema = z
  .object({ name: z.enum(ARTIFACT_NAMES), bytes: z.number().int().nonnegative(), sha256 })
  .strict();

export const pairManifestSchema = z
  .object({
    format: z.literal(PAIR_FORMAT),
    pairId: uuid,
    host,
    hostInstanceId: z.string().min(1).max(200),
    backendIncarnation: z.string().min(1).max(200),
    captureStartedAt: instant,
    boundary: z
      .object({
        lastOperationId: uuid.nullable(),
        // A pair is only taken with nothing executing and no slot held.
        executingOperations: z.literal(0),
        heldEffectSlots: z.literal(0),
      })
      .strict(),
    schemaRevision: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
    releaseBuild: z.string().regex(/^[0-9a-f]{12,40}$/),
    artifacts: z
      .array(artifactSchema)
      .length(ARTIFACT_NAMES.length)
      .refine((list) => new Set(list.map((a) => a.name)).size === ARTIFACT_NAMES.length, {
        message: "each artifact exactly once",
      }),
    keyRefs: z
      .object({
        kmsKeyId: z.string().min(1).max(200),
        sealName: z.string().min(1).max(200),
        /** A reference to the custody copy, never the password. */
        backupPassword: z.string().regex(/^[a-z]+\/[0-9]+$/),
        signingKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      })
      .strict(),
    tools: z
      .object({
        postgres: z.string().min(1).max(64),
        openbao: z.string().min(1).max(64),
        restic: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();

export type PairManifest = z.infer<typeof pairManifestSchema>;

export const eligibilitySchema = z
  .object({
    manifest: pairManifestSchema,
    verification: z
      .object({
        bundleSha256: sha256,
        downloadedSha256: sha256,
        resticCheck: z.literal("read-data"),
        verifiedAt: instant,
      })
      .strict()
      .refine((v) => v.bundleSha256 === v.downloadedSha256, {
        message: "the downloaded bundle differs from the uploaded one",
      }),
    eligibleUntil: instant,
    signature: z
      .object({
        alg: z.literal("ed25519"),
        keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        value: z.string().regex(/^[A-Za-z0-9+/=]+$/),
      })
      .strict(),
  })
  .strict();

export type Eligibility = z.infer<typeof eligibilitySchema>;

/** The object keys of a pair: `pairs/<host>/<captureUtc>-<pairId>/…`. */
export function pairPrefix(m: Pick<PairManifest, "host" | "captureStartedAt" | "pairId">): string {
  const utc = m.captureStartedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `pairs/${m.host}/${utc}-${m.pairId}/`;
}

/** Exactly the three artifacts, each with the manifest's size and digest. */
export function artifactsMatch(
  manifest: PairManifest,
  listing: Readonly<Record<string, { bytes: number; sha256: string }>>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const artifact of manifest.artifacts) {
    const found = listing[artifact.name];
    if (found === undefined) problems.push(`missing: ${artifact.name}`);
    else if (found.bytes !== artifact.bytes || found.sha256 !== artifact.sha256) {
      problems.push(`changed: ${artifact.name}`);
    }
  }
  for (const name of Object.keys(listing)) {
    if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) problems.push(`extra: ${name}`);
  }
  return { ok: problems.length === 0, problems };
}
