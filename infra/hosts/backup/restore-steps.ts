// Run 6.7 Task B (P-124 steps 2 to 4, D-55): the host side of a restore, as
// pure builders of shell text over the backup's tmpfs layout (steps.ts): the
// verified bundle arrives on stdin as downloaded.tar, Restic checks every byte
// and restores the artifacts into restore/out/artifacts, each artifact is
// compared with the manifest's digest, then PostgreSQL and OpenBao are
// restored. `host.ts <host> restore` runs them through sshExec, with
// secretOutput where a step names the secrets directory.
//
// Secrets: the superuser password is read on the host inside the command
// ("$(cat …)"), never passed; the OpenBao token reaches the tmpfs as a header
// file written from stdin and is deleted after its step.
import type { PairManifest } from "@mykey/backup";
import { PAIR_ROOT, PAIR_TMPFS_SIZE, pairSteps } from "./steps.ts";

const CA = "/etc/mykey/pki/ca.crt";
const BAO = { address: "10.78.3.2", port: 8200 };
const SUPERUSER_PASSWORD = "/etc/mykey/secrets/postgres/superuser-password";
/** Seconds to wait for a restored OpenBao to serve a token (the first request took ~6 s). */
export const BAO_WARM_SECONDS = 120;

export interface RestoreSteps {
  mount: string;
  receive: string;
  unpack: string;
  resticCheck: string;
  resticRestore: string;
  digests: string;
  pgRestore: string;
  baoHeader: string;
  baoRestore: string;
  baoWarm: string;
  baoForget: string;
  cleanup: string;
}

export function restoreSteps(manifest: Pick<PairManifest, "pairId" | "artifacts">): RestoreSteps {
  const pair = pairSteps(manifest.pairId); // refuses a pair id that is not a UUID
  const root = `${PAIR_ROOT}/${manifest.pairId}`;
  const q = (sub: string) => `'${sub === "" ? root : `${root}/${sub}`}'`;
  const bao = `--cacert ${CA} --resolve openbao:${String(BAO.port)}:${BAO.address} https://openbao:${String(BAO.port)}/v1`;
  const lines = manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\\n");
  return {
    mount: [
      `install -d -m 0755 ${PAIR_ROOT}`,
      `install -d -m 0700 -o 1000 -g 1000 ${q("")}`,
      `(mountpoint -q ${q("")} || mount -t tmpfs -o size=${PAIR_TMPFS_SIZE},mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec tmpfs ${q("")})`,
      `install -d -m 0700 -o 1000 -g 1000 ${q("in")} ${q("restore")}`,
    ].join(" && "),
    receive: `cat > ${q("downloaded.tar")}`,
    unpack: pair.tmpfs.unpack,
    resticCheck: pair.restic.check,
    resticRestore: pair.restic.restore,
    digests: `cd ${q("restore/out/artifacts")} && printf '${lines}\\n' | sha256sum --check --strict --quiet`,
    pgRestore: `PGPASSWORD="$(cat ${SUPERUSER_PASSWORD})" docker exec -i -e PGPASSWORD -u postgres mykey-postgres-1 pg_restore --exit-on-error --single-transaction --dbname=postgres < ${q("restore/out/artifacts/postgres.dump")}`,
    baoHeader: `umask 077 && cat > ${q("in/bao-header")}`,
    baoRestore: `curl --fail --silent --show-error --max-time 600 -X POST -H @${q("in/bao-header")} --data-binary @${q("restore/out/artifacts/openbao.snap")} ${bao}/sys/storage/raft/snapshot-force`,
    baoWarm: `for i in $(seq 1 ${String(BAO_WARM_SECONDS / 2)}); do curl --fail --silent --max-time 30 -o /dev/null -H @${q("in/bao-header")} ${bao}/auth/token/lookup-self && exit 0; sleep 2; done; exit 1`,
    baoForget: `rm -f ${q("in/bao-header")}`,
    cleanup: `(umount ${q("")} 2>/dev/null || true) && rmdir ${q("")}`,
  };
}
