// Run 6.7 Task B (P-124, D-55): the host side of a restore, as text builders
// over the backup's tmpfs layout. Secrets reach the host only through files
// written from stdin into the tmpfs, never in a command line.
import { randomUUID } from "node:crypto";
import type { PairManifest } from "@mykey/backup";
import { describe, expect, it } from "vitest";
import { restoreSteps } from "../../../infra/hosts/backup/restore-steps.ts";

const pairId = randomUUID();
const manifest = {
  pairId,
  artifacts: [
    { name: "postgres.dump", bytes: 10, sha256: "a".repeat(64) },
    { name: "globals.sql", bytes: 11, sha256: "b".repeat(64) },
    { name: "openbao.snap", bytes: 12, sha256: "c".repeat(64) },
  ],
} as unknown as PairManifest;

describe("restoreSteps (P-124)", () => {
  const steps = restoreSteps(manifest);
  const root = `/var/lib/mykey/pairs/${pairId}`;

  it("refuses a pair id that is not a uuid", () => {
    expect(() => restoreSteps({ ...manifest, pairId: "x; rm -rf /" })).toThrow(/UUID/);
  });

  it("works in the pair's own tmpfs, mounted like the backup's, and unmounts it at the end", () => {
    expect(steps.mount).toContain(
      `mount -t tmpfs -o size=1g,mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec tmpfs '${root}'`,
    );
    expect(steps.receive).toBe(`cat > '${root}/downloaded.tar'`);
    expect(steps.cleanup).toContain(`umount '${root}'`);
  });

  // Run 6.8: the host restore runs the steps as root, restic as uid 1000.
  it("hands what it unpacked to the ops user, so restic (uid 1000) can restore into restore/out", () => {
    expect(steps.unpack).toMatch(new RegExp(`chown -R 1000:1000 '${root}/restore'$`));
  });

  it("checks every artifact against the manifest's digest", () => {
    for (const artifact of manifest.artifacts) {
      expect(steps.digests).toContain(`${artifact.sha256}  ${artifact.name}`);
    }
    expect(steps.digests).toContain("sha256sum --check --strict");
    expect(steps.digests).toContain(`cd '${root}/restore/out/artifacts'`);
  });

  it("runs Restic's read-data check before the restore, as the backup's verify does", () => {
    expect(steps.resticCheck).toContain("check --read-data");
    expect(steps.resticRestore).toContain("restore latest --target /out");
  });

  it("restores the database in one transaction that stops at the first error", () => {
    expect(steps.pgRestore).toContain(
      "pg_restore --exit-on-error --single-transaction --dbname=postgres",
    );
    expect(steps.pgRestore).toContain(`< '${root}/restore/out/artifacts/postgres.dump'`);
  });

  it("restores OpenBao with a header file from stdin, then waits until a token is served", () => {
    expect(steps.baoHeader).toBe(`umask 077 && cat > '${root}/in/bao-header'`);
    expect(steps.baoRestore).toContain("sys/storage/raft/snapshot-force");
    expect(steps.baoRestore).toContain(`-H @'${root}/in/bao-header'`);
    expect(steps.baoRestore).toContain(
      `--data-binary @'${root}/restore/out/artifacts/openbao.snap'`,
    );
    // The first authenticated request after a restore takes ~6 s (Task B finding).
    expect(steps.baoWarm).toContain("auth/token/lookup-self");
    expect(steps.baoWarm).toMatch(/for i in \$\(seq 1 \d+\)/);
    expect(steps.baoForget).toBe(`rm -f '${root}/in/bao-header'`);
  });

  it("never holds a token, a password or a secret id in a command line", () => {
    const text = Object.values(steps).join("\n");
    expect(text).not.toMatch(/X-Vault-Token: [A-Za-z0-9.]/);
    expect(text).not.toMatch(/PGPASSWORD=['"]?[A-Za-z0-9]/);
    expect(text).not.toMatch(/secret_id/);
  });
});
