// Run 5.2 Task D (FR-1.39, FR-1.41, FR-1.42, FR-1.43, P-102): machine
// credentials on staging, through the public name as the staging owner, in a
// project of their own.
//
// 1. The journey: issue (300 s) → the inventory shows it → the replay answers
//    409 credential_not_replayable → revoke → the inventory says revoked. On
//    the host the token's bytes are searched (on fd 3, counts only) in the
//    API's log, a pg_dump and Traefik's access log: 0 each, with the controls
//    found.
// 2. The drill: issuances run in two environments, three at a time each, while
//    the OpenBao container is paused for 8 s; one caught after its marker
//    answers 503 outcome_unknown. Then: the probe raises operations_unresolved;
//    quiesce; ops reconcile-credentials --executors-excluded yes; resume, gate
//    open; a new issuance for that environment → 201, revoked; the alert clears.
//
// Every credential this file issues is revoked in `finally` (they live 60 to
// 300 s in any case). The token never leaves this process except on stdin.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countOnHost,
  expectSuccess,
  hostStatus,
  loadHosts,
  registerSecret,
  sshExec,
} from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const OPENBAO = "mykey-openbao-1";

let cookie: string;
let projectPath: string;
const environments: { id: string; path: string }[] = [];
const issued = new Map<string, string>(); // credentialId → environment path
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-5/run-5.2-staging.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const now = (): string => new Date().toISOString();
const startedAt = new Date();

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const errorOf = (
  answer: PublicAnswer,
): { code?: string; operationId?: string; details?: unknown } => json(answer).error ?? {};

function send(
  method: string,
  path: string,
  body: unknown,
  key: string = randomUUID(),
): Promise<PublicAnswer> {
  return publicRequest(method, path, { body, cookie, headers: { "idempotency-key": key } });
}

/** Issues; a 201's token is registered for redaction at once and never printed. */
async function issue(
  path: string,
  ttlSeconds: number,
  key?: string,
): Promise<{ answer: PublicAnswer; credentialId?: string; token?: string }> {
  const answer = await send("POST", `${path}/credentials`, { name: "s5-machine", ttlSeconds }, key);
  if (answer.status !== 201) return { answer };
  const body = json(answer) as { credential: { credentialId: string }; token: string };
  registerSecret(body.token);
  issued.set(body.credential.credentialId, path);
  return { answer, credentialId: body.credential.credentialId, token: body.token };
}

async function inventory(path: string): Promise<{ credentialId: string; state: string }[]> {
  const listed = await publicRequest("GET", `${path}/credentials`, { cookie });
  expect(listed.status).toBe(200);
  return json(listed).credentials as { credentialId: string; state: string }[];
}

/** Revokes every credential of this file that is not revoked yet; answers how many it revoked. */
async function revokeAll(): Promise<number> {
  let revoked = 0;
  for (const [credentialId, path] of issued) {
    const answer = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200) revoked += 1;
    if (answer.status === 200 || errorOf(answer).code === "state_conflict")
      issued.delete(credentialId);
  }
  return revoked;
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

async function environmentActive(environmentId: string): Promise<void> {
  await waitUntil(
    "environment active",
    async () => {
      const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
      const all = (json(listed).environments ?? []) as { id: string; state: string }[];
      return all.find((e) => e.id === environmentId)?.state;
    },
    (state) => state === "active",
    180_000,
  );
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-credentials-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}`;
  const second = await send("POST", `${projectPath}/environments`, { name: "drill" });
  expect(second.status, second.body.slice(0, 200)).toBe(201);
  const secondId = (json(second).result as { environmentId: string }).environmentId;
  for (const id of [result.developmentEnvironmentId, secondId]) {
    await environmentActive(id);
    environments.push({ id, path: `${projectPath}/environments/${id}` });
  }
  record("project", { name, id: result.projectId, environments: environments.map((e) => e.id) });
}, 420_000);

describe("machine credentials on staging", () => {
  it("issue → inventory → replay 409 → revoke → revoked; the token is in no log, dump or access log", async () => {
    const path = environments[0]!.path;
    try {
      const key = randomUUID();
      const first = await issue(path, 300, key);
      expect(first.answer.status, first.answer.body.slice(0, 200)).toBe(201);
      const credentialId = first.credentialId!;
      expect((await inventory(path)).find((c) => c.credentialId === credentialId)?.state).toBe(
        "active",
      );
      const replay = await send(
        "POST",
        `${path}/credentials`,
        { name: "s5-machine", ttlSeconds: 300 },
        key,
      );
      expect(replay.status).toBe(409);
      expect(errorOf(replay).code).toBe("credential_not_replayable");
      expect(errorOf(replay).details).toEqual({ credentialId, state: "active" });
      expect(replay.body.includes(first.token!)).toBe(false);
      const revoked = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
        confirmed: true,
      });
      expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      issued.delete(credentialId);
      expect((await inventory(path)).find((c) => c.credentialId === credentialId)?.state).toBe(
        "revoked",
      );
      record("journey", { credentialId, at: now() });

      // On the host: the token travels on stdin; only counts come back.
      const since = startedAt.toISOString();
      const token = [first.token!];
      const apiLog = await countOnHost(host, `docker logs --since ${since} mykey-api-1`, token, [
        "/credentials/:credential/revoke",
      ]);
      const dump = await countOnHost(
        host,
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        token,
        [credentialId],
      );
      const access = await countOnHost(host, `docker logs --since ${since} mykey-edge-1`, token, [
        `/credentials/${credentialId}/revoke`,
      ]);
      record("search", { apiLog, dump, access });
      expect(apiLog.found).toBe(0);
      expect(dump.found).toBe(0);
      expect(access.found).toBe(0);
    } finally {
      await revokeAll();
    }
  }, 600_000);

  it("the drill: an issuance left unknown raises operations_unresolved and is settled by quiesce → reconcile-credentials → resume", async () => {
    let paused = false;
    let quiesced = false;
    const caught = new Map<string, string>(); // environment id → operation id
    try {
      // 1. Three issuances at a time in each environment while OpenBao is paused, until one is unknown.
      let attempts = 0;
      for (let attempt = 1; attempt <= 3 && caught.size === 0; attempt += 1) {
        attempts = attempt;
        ({ cookie } = await stagingOwnerSession());
        let stop = false;
        const answers: Record<string, number> = {};
        const loops = environments.flatMap((environment) =>
          [0, 1, 2].map(async () => {
            while (!stop) {
              const { answer } = await issue(environment.path, 60);
              const code = errorOf(answer).code;
              const label = answer.status === 201 ? "201" : `${answer.status} ${code ?? ""}`;
              answers[label] = (answers[label] ?? 0) + 1;
              if (answer.status === 201) continue;
              const operationId = errorOf(answer).operationId;
              if (code === "outcome_unknown" && operationId !== undefined) {
                if (!caught.has(environment.id)) caught.set(environment.id, operationId);
              }
              if (code === "state_conflict" || code === "outcome_unknown") return;
              await sleep(200);
            }
          }),
        );
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
        await revokeAll();
      }
      record("caught", { attempts, operations: Object.fromEntries(caught) });
      expect(caught.size, "no issuance was caught after its marker").toBeGreaterThan(0);
      const [environmentId] = [...caught.keys()];
      const environment = environments.find((e) => e.id === environmentId)!;

      // 2. The environment is blocked for issuance.
      const blocked = await send("POST", `${environment.path}/credentials`, {
        name: "s5-machine",
        ttlSeconds: 60,
      });
      expect(blocked.status).toBe(409);
      expect(errorOf(blocked).code).toBe("state_conflict");

      // 3. The probe raises operations_unresolved.
      const raised = await waitUntil(
        "operations_unresolved at the probe",
        () => Promise.resolve(probeState()),
        (s) => typeof s.open?.operations_unresolved?.lastAlertAt === "number",
        420_000,
      );
      record("alert", {
        delivered: new Date(raised.open?.operations_unresolved?.lastAlertAt ?? 0).toISOString(),
      });

      // 4. quiesce → reconcile-credentials with exclusion → resume → gate open.
      quiesced = true;
      const quiesce = hostTs(["quiesce"]);
      expect(quiesce.code, quiesce.out.slice(-300)).toBe(0);
      expect(quiesce.out).toContain("executors: stopped");
      record("quiesced", now());
      for (const id of caught.keys()) {
        const settled = hostTs([
          "ops",
          "reconcile-credentials",
          "--environment",
          id,
          "--executors-excluded",
          "yes",
        ]);
        expect(settled.code, settled.out.slice(-300)).toBe(0);
        record(`reconciled ${id}`, settled.out.trim().split("\n")[0]);
      }
      expect(hostTs(["resume"]).code).toBe(0);
      expect(hostTs(["gate", "open"]).code).toBe(0);
      quiesced = false;
      record("resumed", now());

      // 5. A new issuance for that environment → 201, revoked; the alert clears.
      await waitUntil(
        "API answering",
        async () => (await publicRequest("GET", "/health", {})).status,
        (status) => status === 200,
        180_000,
      );
      ({ cookie } = await stagingOwnerSession());
      const next = await issue(environment.path, 60);
      expect(next.answer.status, next.answer.body.slice(0, 200)).toBe(201);
      expect(await revokeAll()).toBeGreaterThanOrEqual(1);
      await waitUntil(
        "operations_unresolved leaves",
        () => Promise.resolve(probeState()),
        (s) => s.open?.operations_unresolved === undefined,
        420_000,
      );
      record("cleared", now());
      const status = await hostStatus(host);
      expect(status.operationsUnresolved).toBe(0);
      expect(status.reviewOpen).toBe(0);
      expect(status.gate).toBe("open");
    } finally {
      if (paused) await pauseOpenBao(false).catch(() => undefined);
      if (
        caught.size > 0 &&
        !quiesced &&
        ((await hostStatus(host)).operationsUnresolved ?? 1) > 0
      ) {
        // Stopped before the settlement: settle it the runbook's way, so no alert stays open.
        hostTs(["quiesce"]);
        quiesced = true;
        for (const id of caught.keys()) {
          hostTs([
            "ops",
            "reconcile-credentials",
            "--environment",
            id,
            "--executors-excluded",
            "yes",
          ]);
        }
      }
      if (quiesced) {
        hostTs(["resume"]);
        hostTs(["gate", "open"]);
      }
      await waitUntil(
        "API answering",
        async () => (await publicRequest("GET", "/health", {})).status,
        (status) => status === 200,
        180_000,
      ).catch(() => undefined);
      ({ cookie } = await stagingOwnerSession());
      await revokeAll();
    }
  }, 2_400_000);
});
