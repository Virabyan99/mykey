// THROW-AWAY (Run 2.9, P-36): the manifest of one paired backup — a PostgreSQL
// dump, the database globals and an OpenBao Raft snapshot taken at one
// boundary — and the check that a directory holds exactly those artifacts.
// Session 6 writes the real format (D-25).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ARTIFACT_NAMES = ["postgres.dump", "globals.sql", "openbao.snap"] as const;
export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

export interface PairManifest {
  format: "mykey-pair-spike/1";
  pairId: string;
  synthetic: true;
  captureStartedAt: string;
  captureFinishedAt: string;
  captureEpoch: string;
  releaseCommit: string;
  /** Last applied migration name and checksum. */
  schemaRevision: string;
  versions: { postgres: string; openbao: string; restic: string };
  seal: { type: string; keyIds: string[] };
  namespaces: string[];
  boundary: { lastOperationId: string | null; executingOperations: 0; heldEffectSlots: 0 };
  artifacts: Record<ArtifactName, { sha256: string; bytes: number }>;
  /** SHA-256 of packages/db/roles/roles.sql. */
  rolesChecksum: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function check(condition: boolean, field: string): void {
  if (!condition) throw new Error(`manifest: invalid ${field}`);
}

export function buildManifest(input: Omit<PairManifest, "format" | "synthetic">): PairManifest {
  check(UUID.test(input.pairId), "pairId");
  check(!Number.isNaN(Date.parse(input.captureStartedAt)), "captureStartedAt");
  check(!Number.isNaN(Date.parse(input.captureFinishedAt)), "captureFinishedAt");
  check(/^\d+$/.test(input.captureEpoch), "captureEpoch");
  check(/^[0-9a-f]{40}$/.test(input.releaseCommit), "releaseCommit");
  check(/^\d{4}_[a-z0-9_]+ [0-9a-f]{64}$/.test(input.schemaRevision), "schemaRevision");
  check(
    (input.boundary.executingOperations as number) === 0 &&
      (input.boundary.heldEffectSlots as number) === 0,
    "boundary (a pair is only taken with no executing operation and no held effect slot)",
  );
  check(
    input.boundary.lastOperationId === null || UUID.test(input.boundary.lastOperationId),
    "boundary.lastOperationId",
  );
  for (const name of ARTIFACT_NAMES) {
    const artifact = input.artifacts[name];
    check(
      SHA256.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes),
      `artifacts.${name}`,
    );
  }
  check(SHA256.test(input.rolesChecksum), "rolesChecksum");
  return { format: "mykey-pair-spike/1", synthetic: true, ...input };
}

/** Exactly the three artifacts (and manifest.json), each with its size and hash. */
export function verifyArtifacts(
  manifest: PairManifest,
  directory: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const present = new Set(readdirSync(directory));
  for (const name of ARTIFACT_NAMES) {
    if (!present.has(name)) {
      problems.push(`missing: ${name}`);
      continue;
    }
    const bytes = readFileSync(join(directory, name));
    const expected = manifest.artifacts[name];
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expected.bytes || sha256 !== expected.sha256)
      problems.push(`changed: ${name}`);
  }
  for (const name of present) {
    if (name !== "manifest.json" && !(ARTIFACT_NAMES as readonly string[]).includes(name)) {
      problems.push(`extra: ${name}`);
    }
  }
  return Promise.resolve({ ok: problems.length === 0, problems });
}
