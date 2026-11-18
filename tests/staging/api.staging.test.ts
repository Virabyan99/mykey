// Run 3.1 Task F: the API image with the service gate on staging, proven
// through the public name. Leaves the gate open.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_RINGS } from "@mykey/auth";
import { createPool } from "@mykey/db";
import { GATE_FILE, gateWriteCommand } from "../../scripts/host.ts";
import { httpsGet, type HttpsAnswer } from "../harness/outside.ts";
import {
  STAGING_OWNER_EMAIL,
  publicRequest,
  sessionPair,
  stagingOwnerSession,
} from "../harness/staging-owner.ts";
import { awaitFreshWindow } from "../harness/windows.ts";
import {
  REMOTE,
  connectStaging,
  expectSuccess,
  loadHosts,
  parseHostEnv,
  registerSecret,
  sshExec,
  type HostEntry,
  type StagingStack,
} from "../harness/staging.ts";

const host: HostEntry = loadHosts().staging;
const API_CONTAINER = "mykey-api-1";
let hostInstanceId = "";
/** The host's own v2 record before the test (open, with its report): written back to open. */
let original = "";

const run = async (command: string, opts: { stdin?: string } = {}): Promise<string> =>
  expectSuccess(await sshExec(host, command, { sudo: true, timeoutMs: 120_000, ...opts }), command)
    .stdout;

// Session 6 gate: staging runs a v2 gate since Run 6.9, which opens only with a
// verification report, and a v1 record reads as closed (cause `version`). The
// test opens by writing the host's own open record back, byte for byte, and
// closes with the same record marked closed, without a report.
async function writeGate(state: "open" | "closed"): Promise<void> {
  const record =
    state === "open"
      ? original
      : `${JSON.stringify({
          ...(JSON.parse(original) as Record<string, unknown>),
          state: "closed",
          reportSha256: null,
          writtenAt: new Date().toISOString(),
        })}\n`;
  await run(gateWriteCommand(), { stdin: record });
}

const errorCode = (answer: HttpsAnswer): string | undefined => {
  try {
    return (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

async function startedAt(): Promise<string> {
  return (await run(`docker inspect --format '{{.State.StartedAt}}' ${API_CONTAINER}`)).trim();
}

beforeAll(async () => {
  // The target first: host.env must name the host of hosts.json.
  const env = parseHostEnv(await run(`cat ${REMOTE.hostEnv}`));
  expect(env.MYKEY_HOSTNAME).toBe(host.hostname);
  expect(env.MYKEY_HOST).toBe("staging");
  hostInstanceId = env.MYKEY_HOST_INSTANCE_ID ?? "";
  expect(hostInstanceId).toMatch(/^[0-9a-f-]{36}$/);
  original = await run(`cat ${GATE_FILE}`);
  expect(JSON.parse(original)).toMatchObject({ version: 2, state: "open" });
});

afterAll(async () => {
  await run(`chmod 0644 ${GATE_FILE}`).catch(() => undefined);
  await writeGate("open");
});

describe("staging service gate", () => {
  it("the gate file is root-owned and the API container sees it read-only", async () => {
    await writeGate("open");
    expect((await run(`stat -c '%U:%G %a' ${GATE_FILE}`)).trim()).toBe("root:root 644");
    // As root inside the container, so only the mount can refuse the write.
    const attempt = await sshExec(
      host,
      `docker exec -u 0 ${API_CONTAINER} sh -c 'echo x >> /run/mykey/gate/gate.json'`,
      { sudo: true },
    );
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toMatch(/Read-only file system/);
    const mounts = JSON.parse(
      await run(`docker inspect --format '{{json .Mounts}}' ${API_CONTAINER}`),
    ) as { Source: string; Destination: string; RW: boolean }[];
    expect(mounts.filter((mount) => mount.Destination === "/run/mykey/gate")).toEqual([
      expect.objectContaining({ Source: "/etc/mykey/gate", RW: false }),
    ]);
  });

  it("closed gate: /health down and /v1/version quarantined through the public name", async () => {
    await writeGate("closed");
    const health = await httpsGet(host.hostname, "/health");
    expect(health.status).toBe(503);
    expect(health.body).toBe('{"status":"down"}');
    const version = await httpsGet(host.hostname, "/v1/version");
    expect(version.status).toBe(503);
    expect(errorCode(version)).toBe("quarantined");
  });

  it("after the gate opens the next request answers 200 without a restart", async () => {
    const before = await startedAt();
    await writeGate("open");
    const version = await httpsGet(host.hostname, "/v1/version");
    expect(version.status).toBe(200);
    expect(JSON.parse(version.body)).toMatchObject({ apiMajor: 1 });
    expect((await httpsGet(host.hostname, "/health")).status).toBe(200);
    expect(await startedAt()).toBe(before);
  });

  it("an atomic replacement under load is never read half-written", async () => {
    const answers: { status: number; code: string | undefined }[] = [];
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 20; i += 1) await writeGate(i % 2 === 0 ? "closed" : "open");
      writing = false;
    })();
    const load = async (): Promise<void> => {
      while (writing || answers.length < 200) {
        const answer = await httpsGet(host.hostname, "/v1/version");
        answers.push({ status: answer.status, code: errorCode(answer) });
        if (answers.length >= 400) return;
      }
    };
    await Promise.all([writer, ...Array.from({ length: 8 }, load)]);
    expect(answers.length).toBeGreaterThanOrEqual(200);
    const unexpected = answers.filter(
      (answer) =>
        answer.status !== 200 && !(answer.status === 503 && answer.code === "quarantined"),
    );
    expect(unexpected).toEqual([]);
    // Both states were seen: the load overlapped the writes.
    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([200, 503]));
    await writeGate("open");
  });

  it("the response carries no-store and Strict-Transport-Security", async () => {
    for (const path of ["/v1/version", "/v1/no-such-route"]) {
      const answer = await httpsGet(host.hostname, path);
      expect(answer.headers["cache-control"], path).toBe("no-store");
      expect(answer.headers["strict-transport-security"], path).toBe("max-age=63072000");
    }
  });

  it("an unreadable gate file is closed with cause unreadable", async () => {
    await writeGate("open");
    await run(`chmod 000 ${GATE_FILE}`);
    try {
      const answer = await httpsGet(host.hostname, "/v1/version");
      expect(answer.status).toBe(503);
      expect(errorCode(answer)).toBe("quarantined");
      const requestId = String(answer.headers["x-request-id"]);
      const line = await run(
        `docker logs --since 5m ${API_CONTAINER} 2>&1 | grep -F '"event":"gate_closed"' | grep -F ${requestId}`,
      );
      expect(JSON.parse(line.trim())).toMatchObject({ event: "gate_closed", cause: "unreadable" });
    } finally {
      await run(`chmod 0644 ${GATE_FILE}`);
    }
    expect((await httpsGet(host.hostname, "/v1/version")).status).toBe(200);
  });
});

describe("staging owner and keys (Run 3.2)", () => {
  const OWNER_EMAIL = "owner@mykey-staging.invalid";

  async function counts(stack: StagingStack): Promise<unknown> {
    const pool = createPool({
      ...stack.pg,
      user: "postgres",
      password: stack.pg.superuser.password,
    });
    try {
      const result = await pool.query(
        `SELECT (SELECT count(*)::int FROM auth."user") AS users,
                (SELECT count(*)::int FROM app.organization) AS organizations,
                (SELECT count(*)::int FROM app.membership WHERE role = 'owner') AS owners,
                (SELECT count(*)::int FROM audit.event WHERE action = 'operator.bootstrap') AS bootstraps`,
      );
      return result.rows[0];
    } finally {
      await pool.end();
    }
  }

  it("the bootstrap repeated on staging reports already_present and the row counts are unchanged", async () => {
    const stack = await connectStaging();
    try {
      const before = await counts(stack);
      // Session 2 spikes left synthetic organizations; the owner and its bootstrap are one each.
      expect(before).toMatchObject({ users: 1, owners: 1, bootstraps: 1 });
      const password = readFileSync(
        join(homedir(), ".mykey", "secrets", "hosts", "staging", "owner-password"),
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/host.ts", "staging", "ops", "bootstrap-owner", "--email", OWNER_EMAIL],
        {
          input: password,
          encoding: "utf8",
          timeout: 300_000,
          env: { ...process.env, MSYS_NO_PATHCONV: "1" },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /^already_present user [0-9a-f-]{36} organization [0-9a-f-]{36}\n$/,
      );
      expect(result.stdout.includes(password.toString("utf8").trim())).toBe(false);
      expect(result.stderr.includes(password.toString("utf8").trim())).toBe(false);
      expect(await counts(stack)).toEqual(before);
    } finally {
      await stack.close();
    }
  });

  it("the key directory on the host holds the eight rings, owner 1000:1000, mode 0600", async () => {
    const listing = await sshExec(
      host,
      "stat -c '%n %u:%g %a' /etc/mykey/secrets/api-keys/*.key && stat -c '%u:%g %a' /etc/mykey/secrets/api-keys",
      { sudo: true, secretOutput: true },
    );
    expect(listing.code).toBe(0);
    const lines = listing.stdout.trim().split("\n");
    const files = lines
      .slice(0, -1)
      .map((line) => line.replace("/etc/mykey/secrets/api-keys/", ""));
    expect(files.sort()).toEqual(KEY_RINGS.map((ring) => `${ring}.k1.key 1000:1000 600`).sort());
    expect(lines.at(-1)).toBe("1000:1000 700");
  });
});

describe("the staging owner through the public name (Run 3.8)", () => {
  it("signs in and receives a Secure, HttpOnly, SameSite=Strict, host-only cookie", async () => {
    const password = readFileSync(
      join(homedir(), ".mykey", "secrets", "hosts", "staging", "owner-password"),
      "utf8",
    ).trim();
    registerSecret(password);
    const answer = await publicRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: STAGING_OWNER_EMAIL, password },
    });
    expect(answer.status, answer.body.slice(0, 300)).toBe(200);
    const cookie = answer.cookies.find((c) => c.startsWith("__Secure-better-auth.session_token="));
    expect(cookie).toBeDefined();
    const attributes = (cookie ?? "").split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toContain("secure");
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=strict");
    expect(attributes).toContain("path=/");
    expect(attributes.some((part) => part.startsWith("domain="))).toBe(false);
    // A password-only session reaches no product route.
    const organizations = await publicRequest("GET", "/v1/organizations", {
      cookie: sessionPair(answer),
    });
    expect(organizations.status).toBe(401);
    expect(errorCode({ status: 401, body: organizations.body } as HttpsAnswer)).toBe(
      "mfa_incomplete",
    );
  });

  it("the completed session lists the active organization", async () => {
    const { cookie } = await stagingOwnerSession();
    const answer = await publicRequest("GET", "/v1/organizations", { cookie });
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.body) as { organizations: { state: string }[] };
    expect(body.organizations.map((organization) => organization.state)).toEqual(["active"]);
  });

  it("a sign-up attempt through the public name is 404", async () => {
    const answer = await publicRequest("POST", "/v1/auth/sign-up/email", {
      body: { email: "someone@mykey-staging.invalid", password: "a-long-password-1", name: "x" },
    });
    expect(answer.status, answer.body.slice(0, 300)).toBe(404);
  });

  it("the sixth sign-in attempt in a minute for an unused synthetic e-mail is 429", async () => {
    const stack = await connectStaging();
    const pool = createPool(
      {
        host: stack.pg.host,
        port: stack.pg.port,
        database: "postgres",
        user: "postgres",
        password: stack.pg.superuser.password,
        caCertPath: stack.pg.caCertPath,
      },
      { max: 2 },
    );
    try {
      await awaitFreshWindow(pool, 60, 40);
      const started = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
      const email = `unused-${randomBytes(4).toString("hex")}@mykey-staging.invalid`;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const answer = await publicRequest("POST", "/v1/auth/sign-in/email", {
          body: { email, password: `wrong-${String(attempt)}-${randomBytes(6).toString("hex")}` },
        });
        statuses.push(answer.status);
      }
      expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
      expect(statuses[5]).toBe(429);
      // Aged away: this test's counters leave no limit behind for the next run.
      await pool.query(
        "UPDATE app.rate_limit SET window_start = window_start - interval '1 day' WHERE window_start >= date_trunc('minute', $1::timestamptz) - interval '1 minute'",
        [started],
      );
    } finally {
      await pool.end();
      await stack.close();
    }
  });
});
