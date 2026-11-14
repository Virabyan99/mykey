// Run 4.5 Task D (FR-1.30, FR-1.31, AC-1.16): the uncertainty drill on
// staging, through the public name as the staging owner.
//
// A change in flight when OpenBao stops answering has an unknown outcome. The
// drill makes one: delete/undelete loops on a dozen keys keep the
// environment's lock busy while the OpenBao container is paused for 8 s. A
// delete or undelete caught after its dispatch marker answers 503
// outcome_unknown. (An update would do too, but its late twin usually lands
// and is then settled without exclusion; a delete or undelete always needs the
// operator's exclusion, which is what this drill is for.)
//
// Then: the environment is blocked except for reveals of other keys; the probe
// raises operations_unresolved; reconcile-operation without exclusion exits 3;
// quiesce, reconcile with exclusion (exit 0), resume, gate open; the key
// changes again with its new tag; the alert clears. Everything is undone in
// `finally` (OpenBao unpaused, resume, gate open).
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { expectSuccess, hostStatus, loadHosts, sshExec } from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const OPENBAO = "mykey-openbao-1";

let cookie: string;
let environmentPath: string;
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-4/run-4.5-drill.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const now = (): string => new Date().toISOString();

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const errorOf = (answer: PublicAnswer): { code?: string; operationId?: string } =>
  json(answer).error ?? {};
const synthetic = (): string => `synthetic-${randomUUID()}`;

interface Current {
  version: number;
  stateTag: string;
  state: "live" | "deleted";
}

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

/** `scripts/host.ts staging …` as a child process. */
function hostTs(args: string[]): { code: number | null; out: string } {
  const result = spawnSync(process.execPath, ["scripts/host.ts", "staging", ...args], {
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The probe's view of staging (`probe.ts state`). */
function probeState(): { open?: Record<string, { lastAlertAt?: number | null }> } {
  const result = spawnSync(process.execPath, ["scripts/probe.ts", "state", "staging"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`probe.ts state: ${result.stderr.slice(-300)}`);
  return (
    JSON.parse(result.stdout) as {
      state: { open?: Record<string, { lastAlertAt?: number | null }> };
    }
  ).state;
}

async function waitUntil<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)}`);
    await sleep(5000);
  }
}

const pauseOpenBao = async (paused: boolean): Promise<void> => {
  expectSuccess(
    await sshExec(host, `docker ${paused ? "pause" : "unpause"} ${OPENBAO}`, {
      sudo: true,
      timeoutMs: 60_000,
    }),
    paused ? "docker pause" : "docker unpause",
  );
};

async function createKey(name: string): Promise<Current> {
  const created = await send("POST", `${environmentPath}/secrets`, { name, value: synthetic() });
  expect(created.status, created.body.slice(0, 200)).toBe(201);
  return json(created).result as Current;
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s4-drill-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = (json(created).result ?? {}) as {
    projectId: string;
    developmentEnvironmentId: string;
  };
  environmentPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments/${result.developmentEnvironmentId}`;
  record("project", { name, id: result.projectId, environmentId: result.developmentEnvironmentId });
  await waitUntil(
    "environment active",
    async () => {
      const listed = await publicRequest(
        "GET",
        `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments`,
        { cookie },
      );
      const environments = (json(listed).environments ?? []) as { id: string; state: string }[];
      return environments.find((e) => e.id === result.developmentEnvironmentId)?.state;
    },
    (state) => state === "active",
    180_000,
  );
}, 240_000);

describe("the uncertainty drill (AC-1.16)", () => {
  it("an unknown delete/undelete blocks its environment, raises operations_unresolved, needs exclusion, and is settled by quiesce → reconcile → resume", async () => {
    const other = `S4_OTHER_${randomBytes(3).toString("hex").toUpperCase()}`;
    await createKey(other);
    let paused = false;
    let quiesced = false;
    let pending: string | null = null;
    try {
      // 1. Delete/undelete loops while OpenBao is paused, until one answer is outcome_unknown.
      // A holder: the loops below set it from their own closures.
      const found: { op: { operationId: string; name: string } | null } = { op: null };
      for (let attempt = 1; attempt <= 3 && found.op === null; attempt += 1) {
        const keys: [string, Current][] = [];
        for (let i = 0; i < 12; i += 1) {
          const name = `S4_DRILL_${randomBytes(4).toString("hex").toUpperCase()}`;
          keys.push([name, await createKey(name)]);
        }
        let stop = false;
        const answers: Record<string, number> = {};
        const loops = keys.map(async ([name, start]) => {
          let current = start;
          while (!stop) {
            const kind = current.state === "live" ? "delete" : "undelete";
            const answer = await send("POST", `${environmentPath}/secrets/${name}/${kind}`, {
              expectedVersion: current.version,
              expectedStateTag: current.stateTag,
              confirmed: true,
            });
            const label =
              answer.status === 200 ? "200" : `${answer.status} ${errorOf(answer).code ?? ""}`;
            answers[label] = (answers[label] ?? 0) + 1;
            if (answer.status !== 200) {
              const error = errorOf(answer);
              if (error.code === "outcome_unknown" && error.operationId !== undefined) {
                found.op ??= { operationId: error.operationId, name };
              }
              return;
            }
            current = json(answer).result as Current;
          }
        });
        await sleep(3000);
        await pauseOpenBao(true);
        paused = true;
        const pausedAt = now();
        await sleep(8000);
        await pauseOpenBao(false);
        paused = false;
        stop = true;
        await Promise.all(loops);
        record(`attempt${String(attempt)}`, { pausedAt, answers });
      }
      const caught = found.op;
      if (caught === null) throw new Error("no request was caught after its dispatch marker");
      pending = caught.operationId;
      record("uncertain", { ...caught, at: now() });

      // 2. The environment is blocked; a reveal of another key is not.
      const reveal = await send("POST", `${environmentPath}/secrets/${caught.name}/reveal`, {});
      expect(reveal.status).toBe(409);
      expect(errorOf(reveal).code).toBe("key_under_review");
      const create = await send("POST", `${environmentPath}/secrets`, {
        name: `S4_BLOCKED_${randomBytes(3).toString("hex").toUpperCase()}`,
        value: synthetic(),
      });
      expect(create.status).toBe(409);
      expect(errorOf(create).code).toBe("key_under_review");
      expect(errorOf(create).operationId).toBe(caught.operationId);
      const otherReveal = await send("POST", `${environmentPath}/secrets/${other}/reveal`, {});
      expect(otherReveal.status).toBe(200);
      await waitUntil(
        "operation uncertain",
        async () =>
          json(await publicRequest("GET", `/v1/operations/${caught.operationId}`, { cookie }))
            .state,
        (state) => state === "uncertain",
        120_000,
      );

      // 3. The probe raises operations_unresolved within five minutes.
      const raised = await waitUntil(
        "operations_unresolved at the probe",
        () => Promise.resolve(probeState()),
        (s) => typeof s.open?.operations_unresolved?.lastAlertAt === "number",
        300_000,
      );
      const delivered = raised.open?.operations_unresolved?.lastAlertAt ?? 0;
      record("alert", { delivered: new Date(delivered).toISOString() });

      // 4. Without exclusion: exit 3.
      const review = hostTs(["ops", "reconcile-operation", "--operation", caught.operationId]);
      expect(review.code, review.out.slice(-300)).toBe(3);
      expect(review.out).toContain("executors_not_excluded");

      // 5. quiesce → reconcile with exclusion → resume → gate open.
      quiesced = true;
      const quiesce = hostTs(["quiesce"]);
      expect(quiesce.code, quiesce.out.slice(-300)).toBe(0);
      expect(quiesce.out).toContain("executors: stopped");
      record("quiesced", now());
      const settled = hostTs([
        "ops",
        "reconcile-operation",
        "--operation",
        caught.operationId,
        "--executors-excluded",
        "yes",
      ]);
      expect(settled.code, settled.out.slice(-300)).toBe(0);
      pending = null;
      const verdict = /^(succeeded|rejected) /m.exec(settled.out)?.[1];
      expect(verdict).toBeDefined();
      record("verdict", verdict);
      expect(hostTs(["resume"]).code).toBe(0);
      expect(hostTs(["gate", "open"]).code).toBe(0);
      quiesced = false;
      record("resumed", now());

      // 6. The key changes again with its new tag; the alert clears.
      await waitUntil(
        "API answering",
        async () => (await publicRequest("GET", "/health", {})).status,
        (status) => status === 200,
        180_000,
      );
      const listed = await publicRequest(
        "GET",
        `${environmentPath}/secrets?prefix=${caught.name}`,
        {
          cookie,
        },
      );
      const row = (json(listed).secrets as (Current & { name: string })[])[0];
      expect(row?.state === "live" || row?.state === "deleted").toBe(true);
      const next =
        row?.state === "live"
          ? await send("PATCH", `${environmentPath}/secrets/${caught.name}`, {
              value: synthetic(),
              expectedVersion: row.version,
              expectedStateTag: row.stateTag,
            })
          : await send("POST", `${environmentPath}/secrets/${caught.name}/undelete`, {
              expectedVersion: row?.version,
              expectedStateTag: row?.stateTag,
              confirmed: true,
            });
      expect(next.status, next.body.slice(0, 200)).toBe(200);
      await waitUntil(
        "operations_unresolved leaves",
        () => Promise.resolve(probeState()),
        (s) => s.open?.operations_unresolved === undefined,
        300_000,
      );
      record("cleared", now());
      const status = await hostStatus(host);
      expect(status.operationsUnresolved).toBe(0);
      expect(status.reviewOpen).toBe(0);
      expect(status.gate).toBe("open");
    } finally {
      if (paused) await pauseOpenBao(false).catch(() => undefined);
      if (pending !== null) {
        // Stopped before the settlement: settle it the runbook's way, so no alert stays open.
        if (!quiesced) hostTs(["quiesce"]);
        quiesced = true;
        const exclude = ["--executors-excluded", "yes"];
        const args = ["ops", "reconcile-operation", "--operation", pending, ...exclude];
        if (hostTs(args).code !== 0) hostTs([...args, "--close-unknown", "yes"]);
      }
      if (quiesced) {
        hostTs(["resume"]);
        hostTs(["gate", "open"]);
      }
    }
  }, 1_800_000);
});
