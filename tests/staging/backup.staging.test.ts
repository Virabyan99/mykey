// Run 6.5 Task D (P-118 … P-120, D-51, D-52, FR-1.66, AC-1.27): the daily pair
// on staging, started through its own unit (mykey-backup.service).
//
// 1. A capture started by the unit ends eligible; its two objects exist and
//    eligible.json verifies against the committed key. During it, staging
//    writes get 503 busy at most while writing is closed and succeed after;
//    reveals succeed throughout. The freeze (capture_started_at to the
//    release) lasts less than 60 s.
// 2. Credentials revoked during a second capture are revoked, and that pair is
//    ineligible (access_reduction).
// 3. The bundle, downloaded to the workstation, restores with the custody
//    password and its three digests equal the manifest's (digests only).
// 4. No object under pairs/ is larger than 5 GiB.
// 6. Run 6.6 (P-121): keyReadable answers false for the destroyed loss-test
//    key of Run 2.7 and true for staging's seal key.
// 5. The backup password, the signing key and the R2 secret are in no unit
//    file, no journal line of the unit and no process list taken during a
//    capture (countOnHost, with controls).
//
// Every credential this file issues is revoked; every secret it writes lives in
// a project of its own. Evidence: docs/evidence/session-6/run-6.5-backup-staging.json.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  artifactsMatch,
  keyReadable,
  bytesOf,
  digestOf,
  eligibilitySchema,
  loadR2Credentials,
  loadTrust,
  r2Store,
  verifyEligibility,
  type Eligibility,
} from "@mykey/backup";
import { beforeAll, describe, expect, it } from "vitest";
import { restic, tarIn } from "../harness/restic.ts";
import {
  countOnHost,
  expectSuccess,
  loadHosts,
  registerSecret,
  shQuote,
  sshExec,
} from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";
import { kmsKeyState, kmsKeyStateCommand } from "../../scripts/host.ts";

const host = loadHosts().staging;
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const UNIT = "mykey-backup.service";
const store = r2Store(loadR2Credentials("mykey-staging-pairs-upload"), "mykey-staging-pairs");
const CUSTODY = join(homedir(), ".mykey", "custody", "staging", "backup");
const EVIDENCE = "docs/evidence/session-6/run-6.5-backup-staging.json";
const evidence: Record<string, unknown> = {};
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

let cookie: string;
let environmentPath: string;
const SEEDED = "S65_SEEDED";

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const codeOf = (answer: PublicAnswer): string | undefined =>
  (json(answer).error as { code?: string } | undefined)?.code;
const send = (method: string, path: string, body: unknown): Promise<PublicAnswer> =>
  publicRequest(method, path, { body, cookie, headers: { "idempotency-key": randomUUID() } });

/** One value from the staging database (the server's socket, as its superuser). */
async function sql(query: string): Promise<string> {
  const command = `PGPASSWORD=$(cat /etc/mykey/secrets/postgres/superuser-password) docker exec -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -c ${shQuote(query)}`;
  return expectSuccess(
    await sshExec(host, command, { sudo: true, secretOutput: true, timeoutMs: 60_000 }),
    "psql",
  ).stdout.trim();
}

interface PairRow {
  id: string;
  status: string;
  reason: string;
  objectKey: string;
  frozenMs: number;
}

async function newestPair(): Promise<PairRow | null> {
  const line = await sql(
    `SELECT id, validation_status, coalesce(invalid_reason, ''), coalesce(object_key, ''),
            round(extract(epoch FROM created_at - capture_started_at) * 1000)
       FROM app.backup_pair WHERE host = 'staging' ORDER BY capture_started_at DESC LIMIT 1`,
  );
  if (line === "") return null;
  const [id = "", status = "", reason = "", objectKey = "", frozen = "0"] = line.split("|");
  return { id, status, reason, objectKey, frozenMs: Number(frozen) };
}

/** Starts the unit without waiting; resolves when it has finished, with its result. */
async function runUnit(): Promise<{ result: string; status: string }> {
  expectSuccess(
    await sshExec(host, `systemctl start --no-block ${UNIT}`, { sudo: true }),
    "starting the unit",
  );
  await sleep(1000);
  for (const deadline = Date.now() + 1_800_000; Date.now() < deadline;) {
    const state = expectSuccess(
      await sshExec(host, `systemctl show -p ActiveState -p Result -p ExecMainStatus ${UNIT}`, {
        sudo: true,
      }),
      "reading the unit",
    ).stdout;
    const active = /ActiveState=(\w+)/.exec(state)?.[1];
    if (active === "inactive" || active === "failed") {
      return {
        result: /Result=(\S+)/.exec(state)?.[1] ?? "",
        status: /ExecMainStatus=(\S+)/.exec(state)?.[1] ?? "",
      };
    }
    await sleep(2000);
  }
  throw new Error("the unit did not finish in 30 min");
}

async function eligibility(objectKey: string): Promise<Eligibility> {
  return eligibilitySchema.parse(
    JSON.parse((await bytesOf(await store.get(`${objectKey}eligible.json`))).toString("utf8")),
  );
}

describe("the daily pair on staging", () => {
  let first: PairRow;

  beforeAll(async () => {
    ({ cookie } = await stagingOwnerSession());
    const name = `s65-backup-${randomBytes(3).toString("hex")}`;
    const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
    expect(created.status, created.body.slice(0, 200)).toBe(201);
    const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
    const projectPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}`;
    environmentPath = `${projectPath}/environments/${result.developmentEnvironmentId}`;
    for (const deadline = Date.now() + 180_000; ;) {
      const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
      const all = (json(listed).environments ?? []) as { id: string; state: string }[];
      if (all.find((e) => e.id === result.developmentEnvironmentId)?.state === "active") break;
      if (Date.now() > deadline) throw new Error("environment not active");
      await sleep(5000);
    }
    const seeded = await send("POST", `${environmentPath}/secrets`, {
      name: SEEDED,
      value: `synthetic-${randomBytes(8).toString("hex")}`,
    });
    expect(seeded.status, seeded.body.slice(0, 200)).toBe(201);
    record("project", { name, id: result.projectId });
  }, 420_000);

  it("a capture started by the unit ends eligible; writes are busy only while closed; reveals succeed; the freeze is under 60 s", async () => {
    const before = await newestPair();
    const writes: { at: number; status: number; code: string | undefined }[] = [];
    const reveals: number[] = [];
    const flag = { running: true };
    // Under the session's 120 requests and 30 reveals a minute (Run 6.3): a write
    // every ~0.6 s, a reveal every fifth; it stops once a write succeeds after a
    // busy one, or after 90 s.
    const traffic = (async () => {
      const until = Date.now() + 90_000;
      for (let n = 0; flag.running && Date.now() < until; n += 1) {
        const write = await send("POST", `${environmentPath}/secrets`, {
          name: `S65_W${String(n)}`,
          value: "synthetic",
        });
        writes.push({ at: Date.now(), status: write.status, code: codeOf(write) });
        if (n % 5 === 0) {
          const reveal = await send("POST", `${environmentPath}/secrets/${SEEDED}/reveal`, {});
          reveals.push(reveal.status);
        }
        if (write.status === 201 && writes.some((w) => w.status === 503)) break;
        await sleep(600);
      }
    })();
    const unit = await runUnit();
    flag.running = false;
    await traffic;
    expect(unit, "the unit's result").toEqual({ result: "success", status: "0" });

    const pair = await newestPair();
    expect(pair?.id).not.toBe(before?.id);
    expect(pair?.status).toBe("eligible");
    if (pair === null) throw new Error("no pair");
    first = pair;
    const objects = (await store.list(first.objectKey)).map((o) =>
      o.key.slice(first.objectKey.length),
    );
    expect(objects.sort()).toEqual(["bundle.tar", "eligible.json"]);
    const signed = await eligibility(first.objectKey);
    expect(verifyEligibility(signed, loadTrust("infra/hosts/backup/trust", "staging"))).toEqual({
      ok: true,
    });
    expect(signed.manifest.pairId).toBe(first.id);

    const refused = writes.filter((w) => w.status !== 201);
    expect(
      refused.every((w) => w.status === 503 && w.code === "busy"),
      JSON.stringify(refused),
    ).toBe(true);
    const busySpanMs = refused.length === 0 ? 0 : (refused.at(-1)?.at ?? 0) - (refused[0]?.at ?? 0);
    expect(writes.at(-1)?.status, "a write after the capture").toBe(201);
    expect(
      reveals.every((status) => status === 200),
      JSON.stringify(reveals),
    ).toBe(true);
    expect(first.frozenMs).toBeLessThan(60_000);
    record("firstCapture", {
      pairId: first.id,
      frozenMs: first.frozenMs,
      writes: writes.length,
      writesBusy: refused.length,
      busySpanMs,
      reveals: reveals.length,
      bundleBytes: signed.manifest.artifacts.reduce((sum, a) => sum + a.bytes, 0),
    });
  }, 1_900_000);

  it("credentials revoked during a second capture are revoked, and that pair is ineligible (access_reduction)", async () => {
    const ids: string[] = [];
    // Five: credential issuance is limited to 5 a minute (Run 6.3).
    for (let n = 0; n < 5; n += 1) {
      const issued = await send("POST", `${environmentPath}/credentials`, {
        name: `s65-${String(n)}`,
        ttlSeconds: 900,
      });
      expect(issued.status, issued.body.slice(0, 200)).toBe(201);
      const body = json(issued) as { credential: { credentialId: string }; token: string };
      registerSecret(body.token);
      ids.push(body.credential.credentialId);
    }
    const revoked: { id: string; status: number }[] = [];
    const flag = { running: true };
    const reductions = (async () => {
      // Wait until writing closes (a probe write answers busy), then revoke one by one.
      while (flag.running) {
        const probe = await send("POST", `${environmentPath}/secrets`, {
          name: `S65_P${randomBytes(3).toString("hex").toUpperCase()}`,
          value: "synthetic",
        });
        if (probe.status === 503) break;
        await sleep(600);
      }
      for (const id of ids) {
        const answer = await send("POST", `${environmentPath}/credentials/${id}/revoke`, {
          confirmed: true,
        });
        revoked.push({ id, status: answer.status });
      }
    })();
    const unit = await runUnit();
    flag.running = false;
    await reductions;
    expect(
      revoked.every((r) => r.status === 200),
      JSON.stringify(revoked),
    ).toBe(true);
    const listed = await publicRequest("GET", `${environmentPath}/credentials`, { cookie });
    const states = (json(listed).credentials as { credentialId: string; state: string }[]).filter(
      (c) => ids.includes(c.credentialId),
    );
    expect(states.every((c) => c.state === "revoked")).toBe(true);
    const pair = await newestPair();
    expect(pair?.status).toBe("ineligible");
    expect(pair?.reason).toBe("access_reduction");
    expect(unit.result, "a crossed pair is the barrier working, not a failed job").toBe("success");
    record("crossedCapture", { pairId: pair?.id, revoked: revoked.length });
  }, 1_900_000);

  it("the bundle downloaded to the workstation restores with the custody password and its three digests equal the manifest's", async () => {
    const work = mkdtempSync(join(tmpdir(), "mykey-staging-pair-"));
    try {
      const signed = await eligibility(first.objectKey);
      const bundle = await bytesOf(await store.get(`${first.objectKey}bundle.tar`));
      writeFileSync(join(work, "bundle.tar"), bundle);
      expect((await digestOf(await store.get(`${first.objectKey}bundle.tar`))).sha256).toBe(
        signed.verification.bundleSha256,
      );
      await tarIn(work, ["-C", "/d", "-xf", "/d/bundle.tar"]);
      mkdirSync(join(work, "out"));
      const restored = await restic(
        { repo: join(work, "repo"), password: join(CUSTODY, "password"), out: join(work, "out") },
        ["restore", "latest", "--target", "/out"],
      );
      expect(restored.code).toBe(0);
      const listing: Record<string, { bytes: number; sha256: string }> = {};
      for (const artifact of signed.manifest.artifacts) {
        const bytes = readFileSync(join(work, "out", "artifacts", artifact.name));
        listing[artifact.name] = await digestOf(Readable.from([bytes]));
      }
      expect(artifactsMatch(signed.manifest, listing)).toEqual({ ok: true, problems: [] });
      record("restoredOnWorkstation", {
        pairId: first.id,
        digests: Object.fromEntries(
          Object.entries(listing).map(([name, d]) => [name, d.sha256.slice(0, 16)]),
        ),
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 900_000);

  it("no object under pairs/ is larger than 5 GiB", async () => {
    const objects = await store.list("pairs/");
    expect(objects.length).toBeGreaterThan(0);
    const largest = Math.max(...objects.map((o) => o.bytes));
    expect(largest).toBeLessThan(5 * 1024 ** 3);
    record("largestObjectBytes", largest);
  });

  it("the password, the signing key and the R2 secret are in no unit file, no journal line of the unit and no process list taken during a capture", async () => {
    const password = readFileSync(join(CUSTODY, "password"), "utf8").trim();
    const signingKey = readFileSync(join(CUSTODY, "signing-key"), "utf8")
      .split("\n")
      .find((line) => line !== "" && !line.startsWith("-----"));
    const r2Secret = loadR2Credentials("mykey-staging-pairs-upload").secretAccessKey;
    const secrets = [password, signingKey ?? "", r2Secret];
    for (const secret of secrets) registerSecret(secret);
    expect(secrets.every((secret) => secret.length >= 32)).toBe(true);

    // A process list sampled every 200 ms while a capture runs.
    expectSuccess(
      await sshExec(
        host,
        "rm -f /var/lib/mykey/s65-ps.txt; setsid sh -c 'for i in $(seq 1 1500); do ps -eo args; sleep 0.2; done' > /var/lib/mykey/s65-ps.txt 2>&1 < /dev/null & echo $! > /var/lib/mykey/s65-ps.pid",
        { sudo: true },
      ),
      "sampling the process list",
    );
    const unit = await runUnit();
    expect(unit.result).toBe("success");
    try {
      const units = await countOnHost(
        host,
        "cat /etc/systemd/system/mykey-backup.service /etc/systemd/system/mykey-backup.timer /etc/systemd/system/mykey-capture-recover.service /opt/mykey/hosts/backup/backup.sh",
        secrets,
        ["ExecStart=", "OnCalendar="],
      );
      const journal = await countOnHost(
        host,
        `journalctl -u ${UNIT} --no-pager --since -3h`,
        secrets,
        ["eligible"],
      );
      const processes = await countOnHost(host, "cat /var/lib/mykey/s65-ps.txt", secrets, [
        "backup.sh",
      ]);
      expect({ units: units.found, journal: journal.found, processes: processes.found }).toEqual({
        units: 0,
        journal: 0,
        processes: 0,
      });
      record("secretsSearch", { units, journal, processes });
    } finally {
      await sshExec(
        host,
        "kill $(cat /var/lib/mykey/s65-ps.pid) 2>/dev/null; rm -f /var/lib/mykey/s65-ps.txt /var/lib/mykey/s65-ps.pid",
        { sudo: true },
      );
    }
  }, 1_900_000);
});

// Run 6.6 Task B (P-121): the restore's refusal of a pair whose KMS key is gone.
describe("keyReadable on staging's KMS", () => {
  const LOSSTEST_DESTROYED = "436f2b46-8a77-45bb-816b-6fba1a36ba62"; // L-A, Run 2.7 (key-loss-staging.txt)
  const STAGING_SEAL = "5ec11f05-091a-460b-a7e6-f1064a6ece0e"; // mykey-staging-seal-1 (custody-map.md)
  const probeWith =
    (cert: string) =>
    async (keyId: string): Promise<boolean> => {
      const answer = expectSuccess(
        await sshExec(host, kmsKeyStateCommand(cert, keyId), { sudo: true, timeoutMs: 120_000 }),
        "okms attributes",
      ).stdout;
      return kmsKeyState(answer) === "Active";
    };

  it("answers false for the destroyed loss-test key of Run 2.7 and true for staging's seal key", async () => {
    expect(await keyReadable(LOSSTEST_DESTROYED, probeWith("losstest-ops"))).toBe(false);
    expect(await keyReadable(STAGING_SEAL, probeWith("staging-seal-2"))).toBe(true);
    writeFileSync(
      "docs/evidence/session-6/run-6.6-key-readable.json",
      `${JSON.stringify({ observedAt: new Date().toISOString(), keyReadable: { [LOSSTEST_DESTROYED]: false, [STAGING_SEAL]: true } }, null, 2)}
`,
    );
  }, 300_000);
});
