// Run 5.2 Task D (FR-1.42, FR-1.43, P-102), a file of its own since Run 8.7: the
// drill of an issuance left unknown on staging, through the public name as the
// staging owner, in a project of its own. The journey (issue → inventory →
// replay → revoke, and the search for the token) is credentials.staging.test.ts.
//
// Up to five attempts of one issuance each (Run 10.3, D-78), each in a fresh
// minute: a trigger on the host freezes OpenBao at the create's audit record,
// so the issuance answers 503 outcome_unknown. Then: the
// probe raises operations_unresolved; quiesce; ops reconcile-credentials
// --executors-excluded yes; resume; a redeploy of the running release opens the
// v2 gate with a report; a new issuance for that environment → 201, revoked;
// the alert clears.
//
// Every credential this file issues is revoked in `finally` (they live 60 s in
// any case). The token never leaves this process except on stdin.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  expectSuccess,
  hostStatus,
  hostUnit,
  loadHosts,
  nextMinute,
  registerSecret,
  sshExec,
  stagingRelease,
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
/** Run 10.3: this session's file, so Session 5's evidence is no longer rewritten. */
const EVIDENCE = "docs/evidence/session-10/credential-drill.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const now = (): string => new Date().toISOString();

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
async function issue(path: string, ttlSeconds: number): Promise<{ answer: PublicAnswer }> {
  const answer = await send("POST", `${path}/credentials`, { name: "s5-machine", ttlSeconds });
  if (answer.status !== 201) return { answer };
  const body = json(answer) as { credential: { credentialId: string }; token: string };
  registerSecret(body.token);
  issued.set(body.credential.credentialId, path);
  return { answer };
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
function hostTs(args: string[], timeoutMs = 600_000): { code: number | null; out: string } {
  const result = spawnSync(process.execPath, ["scripts/host.ts", "staging", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
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

/**
 * Run 10.3 (D-78): where the trigger reads and writes on the host. The audit
 * device's file through its volume, and OpenBao's own cgroup.freeze (cgroup v2,
 * Docker's systemd driver). The file refuses to start without both.
 */
async function triggerPaths(): Promise<{ audit: string; freeze: string }> {
  const answer = expectSuccess(
    await sshExec(
      host,
      [
        `id=$(docker inspect -f '{{.Id}}' ${OPENBAO})`,
        `src=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/openbao/audit"}}{{.Source}}{{end}}{{end}}' ${OPENBAO})`,
        'f="/sys/fs/cgroup/system.slice/docker-$id.scope/cgroup.freeze"',
        'test -w "$f" && test -f "$src/audit.log" && printf "%s\\n%s\\n" "$src/audit.log" "$f"',
      ].join("; "),
      { sudo: true, timeoutMs: 60_000 },
    ),
    "the trigger's paths",
  ).stdout.trim();
  const [audit, freeze] = answer.split("\n");
  if (audit === undefined || freeze === undefined) throw new Error("the trigger's paths: none");
  return { audit, freeze };
}

/** Thaws OpenBao, whatever the trigger did. */
const thaw = async (freeze: string): Promise<void> => {
  await sshExec(host, `echo 0 > ${freeze}`, { sudo: true, timeoutMs: 60_000 });
};

const TRIGGER = readFileSync("tests/staging/host-scripts/freeze-on-create.sh", "utf8");
const microseconds = (report: string, word: string): number | null => {
  const found = new RegExp(`^${word} (\\d+)$`, "m").exec(report)?.[1];
  return found === undefined ? null : Number(found);
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
  const name = `s5-drill-${randomBytes(3).toString("hex")}`;
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

describe("the credential drill on staging", () => {
  it("an issuance left unknown raises operations_unresolved and is settled by quiesce → reconcile-credentials → resume", async () => {
    let freezeFile: string | null = null;
    let quiesced = false;
    const caught = new Map<string, string>(); // environment id → operation id
    try {
      // 1. Run 10.3 (D-78): one issuance per attempt, its fault placed on the
      //    host. The trigger follows OpenBao's audit device and freezes
      //    OpenBao at the request record of this environment's token create,
      //    which OpenBao writes before it handles the request: the create is
      //    received and unanswered, and the API gives up at its deadline with
      //    outcome_unknown. A pause sent over SSH lands 2.5 to 3.4 s late and
      //    missed that one-call window 20 times in 20 (Session 8).
      const paths = await triggerPaths();
      freezeFile = paths.freeze;
      let attempts = 0;
      for (let attempt = 1; attempt <= 5 && caught.size === 0; attempt += 1) {
        attempts = attempt;
        await nextMinute();
        ({ cookie } = await stagingOwnerSession());
        const environment = environments[(attempt - 1) % environments.length]!;
        const unit = await hostUnit(
          host,
          `mykey-test-freeze-${String(attempt)}-${randomBytes(3).toString("hex")}`,
          TRIGGER,
          [environment.id, "8", "30"],
          {
            runtimeMaxSec: 60,
            stopPost: `echo 0 > ${paths.freeze}`,
            setenv: { AUDIT_LOG: paths.audit, FREEZE_FILE: paths.freeze },
          },
        );
        await unit.waitFor(/^armed \d+$/m, 30_000);
        const sentAt = now();
        const { answer } = await issue(environment.path, 60);
        const code = errorOf(answer).code;
        const operationId = errorOf(answer).operationId;
        if (code === "outcome_unknown" && operationId !== undefined) {
          caught.set(environment.id, operationId);
        }
        await sleep(10_000);
        const report = await unit.report();
        const matched = microseconds(report, "matched");
        const frozen = microseconds(report, "frozen");
        record(`attempt${String(attempt)}`, {
          sentAt,
          answer: answer.status === 201 ? "201" : `${String(answer.status)} ${code ?? ""}`,
          matched: matched !== null,
          reactionMs: matched === null || frozen === null ? null : (frozen - matched) / 1000,
        });
        await thaw(paths.freeze);
        await revokeAll();
      }
      record("caught", { attempts, operations: Object.fromEntries(caught) });
      expect(caught.size, "no issuance was caught after its marker").toBeGreaterThan(0);
      const [environmentId] = [...caught.keys()];
      const environment = environments.find((e) => e.id === environmentId)!;

      // 2. The caught issuance is unresolved in one of its two documented states
      //    (P-87): `needs_review` (no token proven) blocks the next issuance;
      //    `revoking` (OpenBao made a token, its withdrawal is unproven) is closed
      //    to machines and blocks nothing. Where the pause lands decides which
      //    (Run 5.2 caught the first, the Session 5 gate the second).
      const unresolved = (await inventory(environment.path)).filter(
        (c) => c.state === "needs_review" || c.state === "revoking",
      );
      expect(unresolved).toHaveLength(1);
      const caughtState = unresolved[0]!.state;
      record("caughtState", caughtState);
      if (caughtState === "needs_review") {
        // The attempt spent the minute's five issuances: a sixth would be 429.
        await nextMinute();
        const blocked = await send("POST", `${environment.path}/credentials`, {
          name: "s5-machine",
          ttlSeconds: 60,
        });
        expect(blocked.status).toBe(409);
        expect(errorOf(blocked).code).toBe("state_conflict");
      }

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
      // A v2 gate opens only with a report: redeploy the running release.
      const reopened = hostTs(["deploy", "--release", stagingRelease()], 1_800_000);
      expect(reopened.code, reopened.out.slice(-500)).toBe(0);
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
      if (freezeFile !== null) await thaw(freezeFile).catch(() => undefined);
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
        hostTs(["deploy", "--release", stagingRelease()], 1_800_000);
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
  }, 4_200_000);
});
