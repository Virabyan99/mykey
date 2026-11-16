// Run 2.6: the off-host alert path, proven on staging with the real channel.
// Needs the deployed probe (`node scripts/probe.ts deploy`, `secrets`) and the
// sink-test Worker (`node scripts/probe.ts sinktest up`, removed at the end).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectSuccess, loadHosts, sshExec } from "../harness/staging.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const EVIDENCE = join(ROOT, "docs/evidence/session-2/probe-drill-staging.txt");
const PROBE = "https://mykey-probe.nomikey.com";
const hosts = loadHosts();
const staging = hosts.staging;

interface ProbeView {
  now: number;
  state: {
    lastHeartbeatAt: number | null;
    open: Record<string, { openedAt: number; lastAlertAt: number | null }>;
  };
  alerts: { condition: string; kind: string; at: number; delivered: number }[];
}

const readToken = (): string =>
  readFileSync(join(homedir(), ".mykey", "secrets", "probe", "read-token"), "utf8").trim();

async function view(host: string): Promise<ProbeView> {
  const response = await fetch(`${PROBE}/v1/state/${host}`, {
    headers: { authorization: `Bearer ${readToken()}` },
    signal: AbortSignal.timeout(20_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ProbeView;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Polls `check` every 15 s until it returns a value or `ms` pass. */
async function until<T>(ms: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch {
      // the probe or the network may be briefly unreachable; try again
    }
    if (Date.now() > deadline) return undefined;
    await sleep(15_000);
  }
}

const record = (line: string): void => {
  appendFileSync(EVIDENCE, `${new Date().toISOString()} ${line}\n`);
};

async function probeCli(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [join(ROOT, "scripts/probe.ts"), ...args], {
    timeout: 300_000,
  });
  return stdout;
}

beforeAll(() => {
  mkdirSync(resolve(EVIDENCE, ".."), { recursive: true });
  // Every run appends; a later partial run must not erase an earlier drill's lines.
  if (!existsSync(EVIDENCE)) {
    writeFileSync(EVIDENCE, `# Probe drills on staging (${staging.hostname}), times in seconds\n`);
  }
});

afterAll(async () => {
  await probeCli("sinktest", "down").catch(() => undefined);
});

describe("the off-host probe", () => {
  it("receives heartbeats from both hosts", async () => {
    for (const host of [staging, hosts.prod]) {
      const current = await view(host.name);
      expect(current.state.lastHeartbeatAt, host.name).not.toBeNull();
      expect(current.now - (current.state.lastHeartbeatAt ?? 0), host.name).toBeLessThan(90_000);
      // Production runs without a gate file (the owner opens it): its /health answers down by
      // design, and the probe marks it `inService: false`, so health_failing does not open there
      // either (after Session 5). Nothing may be open on either host.
      expect(Object.keys(current.state.open).sort(), host.name).toEqual([]);
    }
  });

  it("does not record an alert as sent when its sink fails", async () => {
    // A new cron trigger can take up to 15 minutes to start (Cloudflare's
    // documentation; observed in Run 2.6): a Worker already up is not redeployed.
    const deployed = await probeCli("sinktest", "rows").then(
      () => true,
      () => false,
    );
    if (!deployed) await probeCli("sinktest", "up");
    const rows = await until(1_200_000, async () => {
      const parsed = JSON.parse(await probeCli("sinktest", "rows")) as {
        state: { json: string }[];
        alerts: { condition: string; kind: string; delivered: number }[];
      };
      const attempts = parsed.alerts.filter((a) => a.condition === "heartbeat_missing");
      return attempts.length >= 3 ? parsed : undefined;
    });
    expect(rows).toBeDefined();
    const open = (JSON.parse(rows?.state[0]?.json ?? "{}") as ProbeView["state"]).open;
    expect(open.heartbeat_missing?.lastAlertAt).toBeNull();
    expect(open.health_failing?.lastAlertAt ?? null).toBeNull();
    expect(rows?.alerts.filter((a) => a.delivered !== 0)).toEqual([]);
    expect(rows?.alerts.every((a) => a.kind === "opened")).toBe(true);
    record(`sink failure: ${rows?.alerts.length} attempts, none delivered, lastAlertAt null`);
    await probeCli("sinktest", "down");
  }, 1_500_000);

  it("a dark host raises both alerts on the real channel and resolves them", async () => {
    const before = await view(staging.name);
    expect(before.state.open).toEqual({});
    const asked = Date.now();
    expectSuccess(
      await sshExec(staging, "/opt/mykey/hosts/firewall/mykey-egress.sh blackout 480", {
        sudo: true,
      }),
      "blackout",
    );
    const dark = asked + 5_000;
    const opened = await until(600_000, async () => {
      const current = await view(staging.name);
      const missing = current.state.open.heartbeat_missing?.lastAlertAt;
      const failing = current.state.open.health_failing?.lastAlertAt;
      return missing != null && failing != null ? { missing, failing } : undefined;
    });
    expect(opened).toBeDefined();
    const missingAfter = Math.round(((opened?.missing ?? 0) - dark) / 1000);
    const failingAfter = Math.round(((opened?.failing ?? 0) - dark) / 1000);
    record(
      `blackout: heartbeat_missing delivered ${missingAfter} s, health_failing delivered ${failingAfter} s after the host went dark`,
    );
    expect(missingAfter).toBeLessThanOrEqual(300);
    expect(failingAfter).toBeLessThanOrEqual(300);

    // The timer armed before the drop restores the host after 480 s.
    const resolved = await until(dark + 480_000 + 300_000 - Date.now(), async () => {
      const current = await view(staging.name);
      return Object.keys(current.state.open).length === 0 ? current : undefined;
    });
    expect(resolved).toBeDefined();
    record(
      `blackout: both resolved ${Math.round((Date.now() - dark) / 1000)} s after the host went dark (restore at 480 s)`,
    );
    const since = (resolved?.alerts ?? []).filter((a) => a.at >= asked);
    for (const condition of ["heartbeat_missing", "health_failing"]) {
      for (const kind of ["opened", "resolved"]) {
        expect(
          since.filter((a) => a.condition === condition && a.kind === kind && a.delivered === 1),
          `${condition} ${kind}`,
        ).toHaveLength(1);
      }
    }
    // SSH over the VPN works again, with no command in between.
    expect((await sshExec(staging, "true", { timeoutMs: 30_000 })).code).toBe(0);
  }, 1_200_000);

  it("a dead endpoint on a live host raises only health_failing", async () => {
    const asked = Date.now();
    expectSuccess(
      await sshExec(
        staging,
        `systemd-run --quiet --collect --on-active=300 --unit=mykey-edge-back-${Math.floor(asked / 1000)} docker start mykey-edge-1 && docker stop mykey-edge-1 >/dev/null`,
        { sudo: true, timeoutMs: 60_000 },
      ),
      "stop edge",
    );
    let heartbeatMissing = false;
    const opened = await until(480_000, async () => {
      const current = await view(staging.name);
      if (current.state.open.heartbeat_missing !== undefined) heartbeatMissing = true;
      return current.state.open.health_failing?.lastAlertAt ?? undefined;
    });
    expect(opened).toBeDefined();
    record(
      `dead endpoint: health_failing delivered ${Math.round(((opened ?? 0) - asked) / 1000)} s after edge stopped`,
    );
    const resolved = await until(asked + 300_000 + 240_000 - Date.now(), async () => {
      const current = await view(staging.name);
      if (current.state.open.heartbeat_missing !== undefined) heartbeatMissing = true;
      return Object.keys(current.state.open).length === 0 ? current : undefined;
    });
    expect(resolved).toBeDefined();
    record(
      `dead endpoint: resolved ${Math.round((Date.now() - asked) / 1000)} s after edge stopped (restart at 300 s)`,
    );
    expect(heartbeatMissing).toBe(false);
    const since = (resolved?.alerts ?? []).filter((a) => a.at >= asked);
    expect(since.map((a) => `${a.condition} ${a.kind} ${a.delivered}`).sort()).toEqual([
      "health_failing opened 1",
      "health_failing resolved 1",
    ]);
  }, 900_000);
});
