// Run 6.7 Task C (P-124, D-55): a restore up to "closed + verifying", the same
// steps for the host (`host.ts <host> restore`) and the local proof. What
// differs between them is the target: where the pair comes from, how a dump
// and a snapshot are restored, where credentials are delivered and how the
// executors start. The steps:
//
//   1 refuse   a target that holds data or whose gate is open (unless the state
//              line says this pair's restore stopped there: then it starts over)
//   2 fetch    the signed, verified pair; its KMS key must be usable here
//   3 postgres a new database: roles with new passwords (globals.sql compared,
//              never executed), pg_restore
//   4 openbao  the snapshot on the same seal, served again; the restore's own
//              root token, minted with the pair's
//   5+6        restoreInvalidate: every credential class, a new incarnation
//   7 start    the executors, closed + verifying, with a new host instance id
//
// Each step writes the target's state line after it; a restore that stops is
// started again from step 1, never continued on the word of an earlier run.
// The caller then runs the journey, restoreVerify (step 8) and, after the
// report, revokes the restore's root token and opens the gate (step 9).
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  globalsUnknownRoles,
  preflightKms,
  type ArtifactName,
  type PairManifest,
  type Refusal,
} from "@mykey/backup";
import { LIMITS } from "@mykey/contracts";
import { ROLE_NAMES, applyRoles, createPool, type DbTarget, type RoleName } from "@mykey/db";
import type { OpenBaoTarget } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import type pg from "pg";
import { restoreInvalidate, type RestoreDeps } from "./restore-invalidate.ts";

export const RESTORE_STEPS = ["fetch", "postgres", "openbao", "invalidate", "start"] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

export interface RestoreState {
  pairId: string;
  step: RestoreStep;
}

export interface RestoreTarget {
  /** Step 1: why this target may not be restored into (data, an open gate), or null. */
  holding(): Promise<string | null>;
  /** The restore's state line on the target. */
  state: {
    read(): Promise<RestoreState | null>;
    write(state: RestoreState): Promise<void>;
  };
  /** Step 2: the signed, verified pair, and local paths of its three artifacts. */
  fetch(): Promise<
    { ok: true; manifest: PairManifest; files: Record<ArtifactName, string> } | Refusal
  >;
  /** Whether this host's KMS identity can use the key (PO-22). */
  kmsUsable(kmsKeyId: string): Promise<boolean>;
  postgres: {
    /** The superuser of the target's database (a new, empty one after reset). */
    superuser: DbTarget;
    /** Makes the database new and empty. */
    reset(): Promise<void>;
    restoreDump(file: string): Promise<void>;
    /** Installs the roles' new passwords where their processes read them. */
    keepPasswords(passwords: Record<RoleName, string>): Promise<void>;
  };
  openbao: {
    target: OpenBaoTarget;
    restoreSnapshot(file: string): Promise<void>;
    /** Waits until the restored instance serves `token` (~6 s after a restore). */
    warm(token: string): Promise<void>;
  };
  /** The lost host's root token (its custody copy): it mints the restore's own. */
  pairRootToken: string;
  deliver: RestoreDeps["deliver"];
  /** Roles globals.sql may create (the inventory). */
  knownRoles: readonly string[];
  /** Step 7: the executors, started closed + verifying with this binding. */
  startVerifying(binding: { backendIncarnation: string; hostInstanceId: string }): Promise<void>;
}

export class RestoreRefused extends Error {}

export interface Restored {
  manifest: PairManifest;
  backendIncarnation: string;
  hostInstanceId: string;
  /** The restored database as its superuser; the caller ends it. */
  pool: pg.Pool;
  /** With the restore's own root token; the caller revokes it after the report. */
  admin: OpenBaoAdmin;
  /** That token itself: host.ts keeps it (0600) between `restore` and `restore-verify`. */
  rootToken: string;
  given: {
    pair_signature: { state: "ok"; observed: string };
    pair_digests: { state: "ok"; observed: string };
  };
}

export async function restoreToVerifying(
  target: RestoreTarget,
  opts: { crashAt?: (step: RestoreStep) => void } = {},
): Promise<Restored> {
  const crash = opts.crashAt ?? (() => undefined);
  const done = async (pairId: string, step: RestoreStep): Promise<void> => {
    await target.state.write({ pairId, step });
    crash(step);
  };

  // 1 + 2: the pair first (its id decides whether a stopped restore may start over).
  const fetched = await target.fetch();
  if (!fetched.ok) throw new RestoreRefused(fetched.cause);
  const { manifest, files } = fetched;
  const previous = await target.state.read();
  if (previous?.pairId !== manifest.pairId) {
    const why = await target.holding();
    if (why !== null) throw new RestoreRefused(why);
  }
  // PO-22: before anything is written, the state line included.
  const kms = await preflightKms(manifest, (id) => target.kmsUsable(id));
  if (!kms.ok) throw new RestoreRefused(kms.cause);
  await done(manifest.pairId, "fetch");

  // 3: a new database, roles with new passwords, the dump.
  const unknown = globalsUnknownRoles(
    readFileSync(files["globals.sql"], "utf8"),
    target.knownRoles,
  );
  if (unknown.length > 0) {
    throw new RestoreRefused(
      `globals.sql creates roles the inventory does not hold: ${unknown.join(", ")}`,
    );
  }
  await target.postgres.reset();
  const passwords = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, randomBytes(24).toString("base64url")]),
  ) as Record<RoleName, string>;
  await applyRoles(target.postgres.superuser, passwords);
  await target.postgres.keepPasswords(passwords);
  await target.postgres.restoreDump(files["postgres.dump"]);
  await done(manifest.pairId, "postgres");

  // 4: the snapshot; the restore's own root token.
  await target.openbao.restoreSnapshot(files["openbao.snap"]);
  await target.openbao.warm(target.pairRootToken);
  const minted = await new OpenBaoAdmin(
    target.openbao.target,
    target.pairRootToken,
  ).createRootToken();
  const admin = new OpenBaoAdmin(target.openbao.target, minted.token);
  await done(manifest.pairId, "openbao");

  // 5 + 6: every credential class; the new incarnation.
  const pool = createPool(target.postgres.superuser, { max: LIMITS.db.opsPool });
  try {
    await restoreInvalidate({ pool, admin, pairId: manifest.pairId, deliver: target.deliver });
    const control = await pool.query<{ incarnation: string | null }>(
      "SELECT backend_incarnation AS incarnation FROM app.service_control",
    );
    const backendIncarnation = control.rows[0]?.incarnation ?? null;
    if (backendIncarnation === null) throw new Error("restore: no incarnation after invalidation");
    await done(manifest.pairId, "invalidate");

    // 7: closed + verifying, a new host instance.
    const hostInstanceId = randomUUID();
    await target.startVerifying({ backendIncarnation, hostInstanceId });
    await done(manifest.pairId, "start");
    return {
      manifest,
      backendIncarnation,
      hostInstanceId,
      pool,
      admin,
      rootToken: minted.token,
      given: {
        pair_signature: { state: "ok", observed: `signed by ${manifest.keyRefs.signingKeyId}` },
        pair_digests: { state: "ok", observed: "bundle and artifacts equal the manifest" },
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
