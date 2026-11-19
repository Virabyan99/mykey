// Run 6.2 Task C (P-110, P-112, FR-1.81): the audit archive on staging. The
// test writes a secret whose value is a run-time canary into a project of its
// own, runs the rotation of OpenBao's audit file and the archive job by hand
// (the timers run them at 01:15 and 01:30 UTC), and then checks:
//  - both timers are enabled and both runs succeeded;
//  - yesterday's app segment and at least one openbao segment are verified
//    in the database and present in R2 under staging/, and the chain holds in
//    the database and in the manifests;
//  - no rotated local file is left whose segment is verified;
//  - the audit route serves today's events of the test's project;
//  - the canary is in no segment written since the test started (downloaded
//    and searched on the workstation; only counts are printed), with a
//    control: the project's id is found in the openbao segment.
// The project stays (projects cannot be deleted); its id goes into the run note.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesOf, loadR2Credentials, r2Store } from "@mykey/backup";
import { chainProblems, createPool, listSegments, type SegmentRow } from "@mykey/db";
import type pg from "pg";
import { connectStaging, expectSuccess, sshExec, type StagingStack } from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const store = r2Store(loadR2Credentials("mykey-audit-archive-upload"), "mykey-audit-archive");

let staging: StagingStack;
let superuser: pg.Pool;
let cookie: string;
let projectId = "";
let started: Date;
const canary = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const send = (method: string, path: string, body?: unknown) =>
  publicRequest(method, path, {
    ...(body === undefined ? {} : { body }),
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
const root = async (command: string, timeoutMs = 120_000) =>
  sshExec(staging.host, command, { sudo: true, timeoutMs });

beforeAll(async () => {
  staging = await connectStaging();
  superuser = createPool({
    ...staging.pg,
    user: "postgres",
    password: staging.pg.superuser.password,
  });
  started = new Date(
    (await superuser.query<{ now: Date }>("SELECT now()")).rows[0]?.now ?? Date.now(),
  );
  ({ cookie } = await stagingOwnerSession());
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
    name: `s6-audit-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.body).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  const environmentPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments/${result.developmentEnvironmentId}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments`,
      { cookie },
    );
    const environments = (json(listed).environments ?? []) as { id: string; state: string }[];
    if (environments.find((e) => e.id === result.developmentEnvironmentId)?.state === "active")
      break;
    if (Date.now() > deadline) throw new Error("the environment did not become active");
    await sleep(3000);
  }
  const secret = await send("POST", `${environmentPath}/secrets`, {
    name: `S6_AUDIT_${randomBytes(4).toString("hex").toUpperCase()}`,
    value: canary,
  });
  expect(secret.status).toBe(201);
  console.log(`audit.staging: project ${projectId}`);
}, 300_000);

afterAll(async () => {
  await superuser.end();
  await staging.close();
});

let segments: SegmentRow[] = [];

describe("the audit archive on staging (P-112)", () => {
  it("the timers are enabled; the rotation and the archive, run by hand, succeed", async () => {
    const enabled = expectSuccess(
      await root("systemctl is-enabled mykey-bao-audit-rotate.timer mykey-audit-archive.timer"),
      "is-enabled",
    ).stdout;
    expect(enabled.trim().split("\n")).toEqual(["enabled", "enabled"]);
    const t0 = Date.now();
    expectSuccess(
      await root("systemctl start mykey-bao-audit-rotate.service", 1_800_000),
      "rotate",
    );
    const t1 = Date.now();
    expectSuccess(await root("systemctl start mykey-audit-archive.service", 3_600_000), "archive");
    const t2 = Date.now();
    console.log(
      `audit.staging: rotation ${String(Math.round((t1 - t0) / 1000))} s, archive ${String(Math.round((t2 - t1) / 1000))} s`,
    );
    for (const unit of ["mykey-bao-audit-rotate.service", "mykey-audit-archive.service"]) {
      const shown = expectSuccess(
        await root(`systemctl show -p Result -p ExecMainStatus ${unit}`),
        unit,
      ).stdout;
      expect(shown, unit).toContain("Result=success");
      expect(shown, unit).toContain("ExecMainStatus=0");
    }
  }, 3_700_000);

  it("yesterday's app segment and an openbao segment are verified, in R2 under staging/, and chained", async () => {
    segments = await listSegments(superuser);
    expect(chainProblems(segments)).toEqual([]);
    const yesterday = new Date(
      Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate() - 1),
    );
    const app = segments.find(
      (segment) => segment.stream === "app" && Date.parse(segment.fromAt) === yesterday.getTime(),
    );
    expect(app?.verifiedAt).not.toBeNull();
    const bao = segments.filter((segment) => segment.stream === "openbao");
    expect(bao.length).toBeGreaterThanOrEqual(1);
    for (const segment of bao) expect(segment.verifiedAt).not.toBeNull();
    const listed = new Map((await store.list("staging/")).map((entry) => [entry.key, entry.bytes]));
    let previous: string | null = null;
    for (const segment of segments) {
      expect(segment.objectKey.startsWith("staging/"), segment.objectKey).toBe(true);
      expect(listed.has(segment.objectKey), segment.objectKey).toBe(true);
      const manifestKey = segment.objectKey.replace(/\.(ndjson|log)\.gz$/, ".manifest.json");
      const manifest = JSON.parse(
        (await bytesOf(await store.get(manifestKey))).toString("utf8"),
      ) as { sequence: number; sha256: string; previousSha256: string | null };
      expect(manifest.sequence).toBe(Number(segment.sequence));
      expect(manifest.sha256).toBe(segment.sha256);
      expect(manifest.previousSha256).toBe(previous);
      previous = manifest.sha256;
    }
    const sizes = bao.map((segment) => listed.get(segment.objectKey) ?? 0);
    console.log(
      `audit.staging: ${String(segments.length)} segments; openbao compressed bytes ${sizes.join(", ")}`,
    );
  }, 600_000);

  it("no rotated local file is left whose segment is verified", async () => {
    const left = expectSuccess(
      await root("ls -1 /var/lib/mykey/bao-audit/rotated"),
      "listing the rotated directory",
    ).stdout;
    const names = left.split("\n").filter((name) => name.endsWith(".log"));
    for (const name of names) {
      const segment = segments.find((s) => s.source === name);
      expect(segment?.verifiedAt ?? null, name).toBeNull();
    }
  });

  it("the audit route serves today's events of the test's project", async () => {
    const answer = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/audit?projectId=${projectId}`,
      { cookie },
    );
    expect(answer.status, answer.body).toBe(200);
    const items = (json(answer).items ?? []) as { action: string }[];
    expect(items.map((item) => item.action)).toContain("project.create");
    expect(items.map((item) => item.action)).toContain("secret.create");
  });

  it("the canary is in no segment written since the test started; the project id is (control)", async () => {
    const recent = segments.filter(
      (segment) => segment.verifiedAt !== null && segment.verifiedAt >= started,
    );
    expect(recent.some((segment) => segment.stream === "openbao")).toBe(true);
    let found = 0;
    let control = 0;
    for (const segment of recent) {
      const text = gunzipSync(await bytesOf(await store.get(segment.objectKey)));
      if (text.includes(canary)) found += 1;
      if (segment.stream === "openbao" && text.includes(projectId)) control += 1;
      console.log(
        `audit.staging: searched segment ${String(segment.sequence)} (${segment.stream}, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)})`,
      );
    }
    expect(control).toBeGreaterThanOrEqual(1);
    expect(found).toBe(0);
  }, 900_000);
});
