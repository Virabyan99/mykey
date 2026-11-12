// Run 2.9: the host-side commands of one paired backup. Pure builders; the
// staging test (tests/staging/pair.staging.test.ts) runs them.
import { describe, expect, it } from "vitest";
import {
  PAIR_ROOT,
  RESTORE_PG_ADDRESS,
  bundleCommands,
  digestCommand,
  globalsCommand,
  parseDigests,
  pairPaths,
  pgDumpCommand,
  pgRestoreCommand,
  pgpassLine,
  r2Config,
  r2Url,
  resticCommand,
  restoreClusterCommands,
  restoreGlobalsCommand,
  tmpfsCommands,
  transferCommand,
} from "../../../infra/backup/pair-spike/host-steps.ts";
import { verifyDigests, type PairManifest } from "../../../infra/backup/pair-spike/manifest.ts";

const ID = "0b7f2c1e-4a5b-4c6d-8e9f-0123456789ab";
const ROOT = `${PAIR_ROOT}/${ID}`;
const IMAGE = /@sha256:[0-9a-f]{64} /;

describe("pair host steps", () => {
  it("keeps everything in a root-only tmpfs named after the pair id", () => {
    expect(pairPaths(ID).root).toBe(ROOT);
    expect(() => pairPaths("../../etc")).toThrow(/pair id/);
    const { open, close } = tmpfsCommands(ID);
    expect(open).toContain(
      `mount -t tmpfs -o size=1g,mode=0700,uid=0,gid=0,nosuid,nodev,noexec tmpfs ${ROOT}`,
    );
    expect(open).toContain(`install -d -m 0700 ${ROOT}/in ${ROOT}/artifacts`);
    expect(close).toBe(`umount ${ROOT} && rmdir ${ROOT}`);
  });

  it("writes libpq password lines with ':' and '\\' escaped", () => {
    expect(pgpassLine("backup_reader", "a:b\\c")).toBe(
      "postgres:5432:*:backup_reader:a\\:b\\\\c\n",
    );
    expect(() => pgpassLine("backup_reader", "two\nlines")).toThrow(/password/);
  });

  it("dumps as backup_reader and the globals as the superuser, verify-full on the db bridge", () => {
    const dump = pgDumpCommand(ID);
    expect(dump).toMatch(IMAGE);
    expect(dump).toContain("--network mykey_db --read-only --cap-drop ALL");
    expect(dump).toContain(`-e PGPASSFILE=/pair/in/pgpass-reader`);
    expect(dump).toContain("--format=custom --file=/pair/artifacts/postgres.dump");
    expect(dump).toContain("user=backup_reader sslmode=verify-full sslrootcert=/ca.crt");
    const globals = globalsCommand(ID);
    expect(globals).toContain(
      "--globals-only --no-role-passwords --file=/pair/artifacts/globals.sql",
    );
    expect(globals).toContain(`-e PGPASSFILE=/pair/in/pgpass-super`);
    expect(globals).toContain("user=postgres sslmode=verify-full");
  });

  it("runs restic without a network, its password only as a file in the tmpfs", () => {
    const check = resticCommand(ID, "repo", ["check", "--read-data"]);
    expect(check).toMatch(IMAGE);
    expect(check).toContain("--network none");
    expect(check).toContain("--password-file /pair/in/restic-password");
    expect(check).toContain("--repo /pair/repo");
    expect(check).toMatch(/--no-cache check --read-data$/);
    expect(resticCommand(ID, "restore/repo", ["snapshots"])).toContain("--repo /pair/restore/repo");
  });

  it("moves files to and from R2 with SigV4 and a config file, never a key in the command", () => {
    const at = { accountId: "a".repeat(32), bucket: "mykey-staging-pairs" };
    expect(r2Url(at, ID, "repo.tar")).toBe(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/mykey-staging-pairs/pairs/${ID}/repo.tar`,
    );
    const up = transferCommand(ID, at, { put: "repo.tar" });
    expect(up).toContain("--aws-sigv4 aws:amz:auto:s3");
    expect(up).toContain(`-K ${ROOT}/in/r2.conf`);
    expect(up).toContain("x-amz-content-sha256: UNSIGNED-PAYLOAD");
    expect(up).toContain(`-T ${ROOT}/repo.tar`);
    const down = transferCommand(ID, at, { get: "repo.tar", into: "restore/repo.tar" });
    expect(down).toContain(`-o ${ROOT}/restore/repo.tar`);
    expect(() => transferCommand(ID, { ...at, accountId: "x;y" }, { put: "repo.tar" })).toThrow();
    expect(r2Config("k".repeat(32), "s".repeat(64))).toBe(
      `user = "${"k".repeat(32)}:${"s".repeat(64)}"\n`,
    );
    expect(() => r2Config('a"b', "c")).toThrow(/credential/);
  });

  it("packs the Restic repository into one tar and unpacks it for the restore", () => {
    expect(bundleCommands(ID)).toEqual({
      pack: `tar -C ${ROOT} -cf ${ROOT}/repo.tar repo`,
      unpack: `tar -C ${ROOT}/restore -xf ${ROOT}/restore/repo.tar`,
    });
  });

  it("starts a disposable PostgreSQL on its own volume and address, and restores into it", () => {
    const cluster = restoreClusterCommands(ID);
    expect(cluster.start).toContain(`--ip ${RESTORE_PG_ADDRESS}`);
    expect(cluster.start).toContain("--name mykey-pair-pg");
    expect(cluster.start).toContain("-c ssl=on");
    expect(cluster.remove).toMatch(
      /docker rm -f mykey-pair-pg; docker volume rm -f mykey-pair-pg-/,
    );
    const globals = restoreGlobalsCommand(ID);
    expect(globals).toContain(`--add-host postgres:${RESTORE_PG_ADDRESS}`);
    expect(globals).toContain("-e PGPASSFILE=/pair/in/pgpass-restore");
    expect(globals).toContain(
      "--globals-only --no-role-passwords --file=/pair/restore/globals-new.sql",
    );
    const restore = pgRestoreCommand(ID);
    expect(restore).toContain(`--add-host postgres:${RESTORE_PG_ADDRESS}`);
    expect(restore).toContain("--exit-on-error");
    expect(restore).toContain("/pair/restore/out/pair/artifacts/postgres.dump");
  });

  it("reads sizes and SHA-256 of the files in a directory, and compares them with the manifest", () => {
    expect(digestCommand(`${ROOT}/artifacts`)).toContain("sha256sum");
    const sha = "c".repeat(64);
    const listing = parseDigests(
      `postgres.dump 10 ${sha}\nglobals.sql 3 ${sha}\nnotes.txt 1 ${sha}\n`,
    );
    expect(listing["postgres.dump"]).toEqual({ bytes: 10, sha256: sha });
    const manifest = {
      artifacts: {
        "postgres.dump": { bytes: 10, sha256: sha },
        "globals.sql": { bytes: 4, sha256: sha },
        "openbao.snap": { bytes: 1, sha256: sha },
      },
    } as unknown as PairManifest;
    expect(verifyDigests(manifest, listing)).toEqual({
      ok: false,
      problems: ["changed: globals.sql", "missing: openbao.snap", "extra: notes.txt"],
    });
  });
});
