// Run 8.4 Task A (P-152, D08-S44, AC-1.13, AC-1.50): every kind of secret the
// product handles, against every surface of the staging host and of the
// operator's workstation.
//
// One seed (tests/harness/sweep.ts): as the staging owner through the public
// name, values created, updated and imported, revealed, revealed at an older
// version and exported; a machine token issued, used and revoked; a password
// reset by the operator and completed; the recovery codes regenerated; signed
// out. With them, the operator's resting secrets: the root token (M1, P-148),
// the backup password and the maintenance password, and the owner's password
// and TOTP seed. Every needle is searched for on every surface; only counts
// come back. Each surface has a control that must be found, and the
// canary-shaped controls travel as the needles do (fd 3 on the host).
//
// What the sweep cannot see:
//  - TOTP codes on the host: six digits are found by chance anywhere;
//  - the page's memory and its query cache (Session 7's finding 12): the
//    browser tests scan what the browser stores, not what it holds;
//  - the inside of the OpenBao snapshot: OpenBao encrypts it, so searching it
//    as bytes (done here) proves little;
//  - the text of a delivered alert: unit tests cover the alert's format;
//  - an agent's transcript.
//
// Writes docs/evidence/session-8/run-8.4-sweep.txt (counts and kinds only).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { bytesOf, loadR2Credentials, r2Store } from "@mykey/backup";
import { createPool, listSegments } from "@mykey/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restic, tarIn } from "../harness/restic.ts";
import {
  connectStaging,
  countOnHost,
  expectSuccess,
  loadHosts,
  sshExec,
  type StagingStack,
} from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession } from "../harness/staging-owner.ts";
import {
  countInBytes,
  countInText,
  seedAndExercise,
  SWEEP_ORGANIZATION,
  type SweepSeed,
} from "../harness/sweep.ts";

const host = loadHosts().staging;
const OUTPUT = "docs/evidence/session-8/run-8.4-sweep.txt";
const LOCK = resolve(import.meta.dirname, "../../infra/dependencies.lock.json");
const BACKUP_CUSTODY = join(homedir(), ".mykey", "custody", "staging", "backup");

let staging: StagingStack;
let superuser: pg.Pool;
let seed: SweepSeed;
const rows: string[] = [];

const values = () => seed.needles.map((needle) => needle.value);
const since = () => seed.startedAt.toISOString();

function record(surface: string, found: number, controls: string, kinds: string[] = []): void {
  rows.push(
    `${surface} | ${String(seed.needles.length)} | ${String(found)} | ${kinds.join(",") || "-"} | ${controls}`,
  );
}

/** One search on the host; the canary-shaped controls go on fd 3 with the needles. */
async function onHost(
  surface: string,
  producer: string,
  controls: string[],
  needleControls: string[] = [],
): Promise<number> {
  const result = await countOnHost(host, producer, values(), controls, needleControls);
  record(
    surface,
    result.found,
    `${String(result.controls)} of ${String(controls.length + needleControls.length)}`,
  );
  return result.found;
}

/** One search of a text the workstation holds; the controls are plain strings that must be in it. */
function inText(surface: string, text: string, controls: string[]): number {
  for (const control of controls) expect(text.includes(control), `${surface}: control`).toBe(true);
  const result = countInText(text, seed.needles);
  record(
    surface,
    result.found,
    `${String(controls.length)} of ${String(controls.length)}`,
    result.kinds,
  );
  return result.found;
}

/** Sweep projects an interrupted run left active (named with a canary-shaped control). */
async function archiveLeftovers(): Promise<void> {
  const left = await superuser.query<{ id: string }>(
    `SELECT id FROM app.project
      WHERE organization_id = $1 AND state = 'active' AND name ~ '^MYKEY_CANARY_[A-Z0-9]{32}$'`,
    [SWEEP_ORGANIZATION],
  );
  if (left.rows.length === 0) return;
  const { cookie } = await stagingOwnerSession();
  for (const { id } of left.rows) {
    const archived = await publicRequest(
      "POST",
      `/v1/organizations/${SWEEP_ORGANIZATION}/projects/${id}/archive`,
      { body: { confirmed: true }, cookie, headers: { "idempotency-key": randomUUID() } },
    );
    expect(archived.status, `archiving leftover ${id}`).toBe(200);
  }
  await publicRequest("POST", "/v1/auth/sign-out", { body: {}, cookie });
}

const root = (command: string, timeoutMs = 120_000) =>
  sshExec(host, command, { sudo: true, timeoutMs });

beforeAll(async () => {
  staging = await connectStaging();
  superuser = createPool({
    ...staging.pg,
    user: "postgres",
    password: staging.pg.superuser.password,
  });
  await archiveLeftovers();
  seed = await seedAndExercise();
  expect(new Set(seed.needles.map((needle) => needle.kind)).size).toBe(10);
}, 900_000);

afterAll(async () => {
  if ((seed as SweepSeed | undefined) === undefined) {
    await superuser.end();
    await staging.close();
    return;
  }
  const header = [
    "# Canary sweep on staging (Run 8.4, P-152)",
    `# ${new Date().toISOString()}; project ${seed.projectId}, environment ${seed.environmentId}; seeded from ${since()}`,
    `# needles: ${[...new Set(seed.needles.map((n) => n.kind))].sort().join(", ")}`,
    "# Values reach the host on fd 3 of the search, never an argument; only counts come back.",
    "# surface | needles searched | needles found | kinds found | controls found",
  ];
  writeFileSync(OUTPUT, `${[...header, ...rows].join("\n")}\n`);
  await superuser.end();
  await staging.close();
});

describe("the canary sweep on staging", () => {
  it("the database: a plain dump of every schema holds no needle; it holds the control name", async () => {
    const found = await onHost(
      "database (pg_dump, every schema)",
      `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
      [],
      [seed.control.secretName, seed.control.projectName],
    );
    expect(found).toBe(0);
  }, 900_000);

  it("OpenBao's audit device, the live file and the rotated ones: no needle in the clear; the control's path is there", async () => {
    const path = `kv/data/p/${seed.projectId}/e/${seed.environmentId}/${seed.control.secretName}`;
    const found = await onHost(
      "OpenBao audit device (live and rotated)",
      "docker exec mykey-openbao-1 sh -c 'cat /openbao/audit/*.log'; cat /var/lib/mykey/bao-audit/rotated/* 2>/dev/null",
      [],
      [path],
    );
    expect(found).toBe(0);
  }, 900_000);

  it("the audit archive: after a rotation and an archive run, no segment written since the start holds a needle; the control is in one", async () => {
    expectSuccess(
      await root("systemctl start mykey-bao-audit-rotate.service", 1_800_000),
      "rotate",
    );
    expectSuccess(await root("systemctl start mykey-audit-archive.service", 3_600_000), "archive");
    const store = r2Store(loadR2Credentials("mykey-audit-archive-upload"), "mykey-audit-archive");
    const recent = (await listSegments(superuser)).filter(
      (segment) => segment.verifiedAt !== null && segment.verifiedAt >= seed.startedAt,
    );
    expect(recent.length).toBeGreaterThanOrEqual(1);
    let found = 0;
    let control = 0;
    const kinds = new Set<string>();
    for (const segment of recent) {
      const bytes = gunzipSync(await bytesOf(await store.get(segment.objectKey)));
      const result = countInBytes(bytes, seed.needles);
      found += result.found;
      for (const kind of result.kinds) kinds.add(kind);
      if (bytes.includes(seed.control.secretName, 0, "utf8")) control += 1;
    }
    record(
      `audit archive (${String(recent.length)} segments since the start)`,
      found,
      `${String(control)} segments hold the control`,
      [...kinds].sort(),
    );
    expect(control).toBeGreaterThanOrEqual(1);
    expect(found).toBe(0);
  }, 3_600_000);

  it("a pair captured after the seeding: its database dump restored to text, its globals, its check log and its manifest hold no needle; the dump holds the control name", async () => {
    const before = await superuser.query<{ id: string }>(
      "SELECT id FROM app.backup_pair WHERE host = 'staging' ORDER BY capture_started_at DESC LIMIT 1",
    );
    expectSuccess(await root("systemctl start --no-block mykey-backup.service"), "start backup");
    await sleep(2000);
    for (const deadline = Date.now() + 1_800_000; ;) {
      const state = expectSuccess(
        await root("systemctl show -p ActiveState mykey-backup.service"),
        "unit state",
      ).stdout;
      if (/ActiveState=(inactive|failed)/.test(state)) break;
      if (Date.now() > deadline) throw new Error("the backup did not finish in 30 min");
      await sleep(5000);
    }
    const pair = (
      await superuser.query<{ id: string; status: string; key: string }>(
        `SELECT id, validation_status AS status, coalesce(object_key, '') AS key
           FROM app.backup_pair WHERE host = 'staging' ORDER BY capture_started_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(pair?.id).not.toBe(before.rows[0]?.id);
    expect(pair?.status).toBe("eligible");
    const store = r2Store(loadR2Credentials("mykey-staging-pairs-upload"), "mykey-staging-pairs");
    const work = mkdtempSync(join(tmpdir(), "mykey-sweep-pair-"));
    try {
      const prefix = pair?.key ?? "";
      const eligible = (await bytesOf(await store.get(`${prefix}eligible.json`))).toString("utf8");
      writeFileSync(
        join(work, "bundle.tar"),
        await bytesOf(await store.get(`${prefix}bundle.tar`)),
      );
      await tarIn(work, ["-C", "/d", "-xf", "/d/bundle.tar"]);
      mkdirSync(join(work, "out"));
      const password = join(BACKUP_CUSTODY, "password");
      const restored = await restic(
        { repo: join(work, "repo"), password, out: join(work, "out") },
        ["restore", "latest", "--target", "/out"],
      );
      expect(restored.code).toBe(0);
      const checked = await restic({ repo: join(work, "repo"), password }, [
        "check",
        "--read-data",
      ]);
      expect(checked.code).toBe(0);
      const artifacts = join(work, "out", "artifacts");
      const lock = JSON.parse(readFileSync(LOCK, "utf8")) as {
        images: Record<string, { image: string; digest: string }>;
      };
      const pin = lock.images.postgres!;
      const dump = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${artifacts}:/d:ro`,
          "--entrypoint",
          "pg_restore",
          `${pin.image}@${pin.digest}`,
          "-f",
          "-",
          "/d/postgres.dump",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
      );
      expect(dump.status, "pg_restore to text").toBe(0);
      let found = 0;
      found += inText("pair: database dump as text", dump.stdout, [
        seed.control.secretName,
        seed.control.projectName,
      ]);
      found += inText("pair: globals.sql", readFileSync(join(artifacts, "globals.sql"), "utf8"), [
        "CREATE ROLE",
      ]);
      found += inText("pair: restic check --read-data log", checked.output, [
        "no errors were found",
      ]);
      found += inText("pair: manifest (eligible.json)", eligible, [pair?.id ?? "-"]);
      found += inText(
        "pair: openbao.snap as bytes (encrypted by OpenBao: proves little)",
        readFileSync(join(artifacts, "openbao.snap")).toString("latin1"),
        [],
      );
      expect(found).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 3_600_000);

  it("containers and processes: no environment and no argument list on the host holds a needle; the control is the value of MYKEY_BASE_URL", async () => {
    const found = await onHost(
      "containers' environments and arguments, every process's arguments and environment",
      [
        `docker ps -q | xargs -r docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}{{.Path}} {{join .Args " "}}'`,
        "ps -eww -o args",
        `for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done`,
      ].join("; "),
      [`https://${host.hostname}`],
    );
    expect(found).toBe(0);
  }, 900_000);

  it("the journals since the start — api, provisioner, postgres, openbao, edge and every mykey-* unit — hold no needle; the edge's holds the control name and the API's the control request id", async () => {
    expectSuccess(
      await root(
        "docker inspect -f '{{.Name}}' mykey-api-1 mykey-provisioner-1 mykey-postgres-1 mykey-openbao-1 mykey-edge-1",
      ),
      "the five containers exist",
    );
    const epoch = Math.floor(seed.startedAt.getTime() / 1000);
    let found = 0;
    found += await onHost(
      "API log",
      `docker logs --since ${since()} mykey-api-1`,
      [],
      [seed.control.requestId],
    );
    found += await onHost(
      "edge (Traefik) log",
      `docker logs --since ${since()} mykey-edge-1`,
      [],
      [seed.control.secretName],
    );
    found += await onHost("provisioner log", `docker logs --since ${since()} mykey-provisioner-1`, [
      '"event":"job"',
    ]);
    found += await onHost(
      "postgres and openbao logs, every mykey-* unit's journal",
      `docker logs --since ${since()} mykey-postgres-1; docker logs --since ${since()} mykey-openbao-1; journalctl --no-pager --since @${String(epoch)} -u 'mykey-*'`,
      ["mykey-backup.service"],
    );
    expect(found).toBe(0);
  }, 900_000);

  it("the reference: the served page, its bundle and the OpenAPI document hold no needle; the control is a route's path", async () => {
    const { cookie } = await stagingOwnerSession();
    seed.needles.push({ kind: "session", value: cookie.slice(cookie.indexOf("=") + 1) });
    const page = await publicRequest("GET", "/v1/reference", { cookie });
    const document = await publicRequest("GET", "/v1/openapi.json", { cookie });
    expect(page.status).toBe(200);
    expect(document.status).toBe(200);
    let found = inText("reference page with its inline bundle", page.body, ["/v1/organizations"]);
    found += inText("OpenAPI document", document.body, ["/v1/organizations"]);
    await publicRequest("POST", "/v1/auth/sign-out", { body: {}, cookie });
    expect(found).toBe(0);
  }, 300_000);

  it("the operator's views: host.ts status --json and the probe's state hold no needle", () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      });
    const status = run(["scripts/host.ts", "staging", "status", "--json"]);
    expect(status.status, "host.ts status --json").toBe(0);
    const probe = run(["scripts/probe.ts", "state", "staging"]);
    expect(probe.status, "probe.ts state").toBe(0);
    let found = inText("host.ts staging status --json", `${status.stdout}${status.stderr}`, [
      "gate",
    ]);
    found += inText("probe.ts state staging", `${probe.stdout}${probe.stderr}`, ["staging"]);
    expect(found).toBe(0);
  }, 600_000);

  it('the workstation: the operator\'s shell histories (Git Bash and PowerShell) hold no needle; the control is "pnpm"', () => {
    const files = [
      join(homedir(), ".bash_history"),
      join(
        process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "PowerShell",
        "PSReadLine",
        "ConsoleHost_history.txt",
      ),
    ].filter((file) => existsSync(file));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(inText(`shell histories (${String(files.length)} files)`, text, ["pnpm"])).toBe(0);
  });

  it("finally: the sweep's project is archived", async () => {
    const { cookie } = await stagingOwnerSession();
    const archived = await publicRequest(
      "POST",
      `/v1/organizations/${SWEEP_ORGANIZATION}/projects/${seed.projectId}/archive`,
      { body: { confirmed: true }, cookie, headers: { "idempotency-key": randomUUID() } },
    );
    expect(archived.status, archived.body.slice(0, 120)).toBe(200);
    await publicRequest("POST", "/v1/auth/sign-out", { body: {}, cookie });
  }, 120_000);
});
