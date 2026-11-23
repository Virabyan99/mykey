// Run 5.6 Task A (FR-1.48, FR-1.49, AC-1.20, Review focus 4 and 5): `secrets
// run` starts the command with the complete set or not at all. The child is
// tests/cli/child.mjs: it records names and value digests (never a value),
// its arguments, its starts and the signals it received in a marker file.
// HOME, TMPDIR, XDG_* and the working directory are fresh empty directories,
// and stay empty whatever happens.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCli, runCli, type StartOptions } from "../harness/cli.ts";
import { underTerminal } from "./pty.ts";
import {
  ENV_NAME,
  PROJECT,
  errorReply,
  goodResolve,
  goodVersion,
  startCliServer,
  type CliServer,
  type Reply,
  type ServerScript,
} from "./server.ts";

const CHILD = join(process.cwd(), "tests", "cli", "child.mjs");
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const token = (): string => `s.${randomBytes(18).toString("base64url")}`;
const synthetic = (label: string): string => `synthetic-${label}-${randomBytes(6).toString("hex")}`;

interface Marker {
  starts: number;
  pid: number;
  argv: string[];
  env: Record<string, string>;
  signals: Record<"SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGUSR1" | "SIGUSR2", number>;
}

let base: string;
let dirs: Record<
  "home" | "tmp" | "cwd" | "config" | "cache" | "data" | "state" | "runtime",
  string
>;
let marker: string;
let release: string;
const servers: CliServer[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mykey-run-")));
  dirs = {
    home: join(base, "home"),
    tmp: join(base, "tmp"),
    cwd: join(base, "cwd"),
    config: join(base, "xdg-config"),
    cache: join(base, "xdg-cache"),
    data: join(base, "xdg-data"),
    state: join(base, "xdg-state"),
    runtime: join(base, "xdg-runtime"),
  };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
  mkdirSync(join(base, "markers"));
  marker = join(base, "markers", "child.json");
  release = join(base, "markers", "release");
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(base, { recursive: true, force: true });
});

async function serve(script: ServerScript = {}): Promise<CliServer> {
  const server = await startCliServer(script);
  servers.push(server);
  return server;
}

function envOf(server: CliServer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SECRETS_API_URL: server.url,
    SECRETS_CA_FILE: server.caPath,
    SECRETS_MACHINE_TOKEN: token(),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    CHILD_RELEASE: release,
    ...extra,
  };
}

const runArgs = (childArgs: string[] = [], flags: string[] = []): string[] => [
  "run",
  "--project",
  PROJECT,
  "--env",
  ENV_NAME,
  ...flags,
  "--",
  process.execPath,
  CHILD,
  marker,
  ...childArgs,
];

const readMarker = (): Marker => JSON.parse(readFileSync(marker, "utf8")) as Marker;
const allEmpty = (): boolean => Object.values(dirs).every((dir) => readdirSync(dir).length === 0);

async function until(what: string, done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function start(
  server: CliServer,
  args: string[],
  extra: Record<string, string> = {},
  opts: StartOptions = {},
) {
  return startCli(args, { env: envOf(server, extra), cwd: dirs.cwd, ...opts });
}

describe("secrets run", () => {
  it("the child gets the complete set and nothing of the CLI", async () => {
    const entries = [
      { name: "DATABASE_URL", value: synthetic("db") },
      { name: "API_KEY", value: synthetic("key") },
      { name: "EMPTY", value: "" },
    ];
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const env = envOf(server);
    const result = await runCli(runArgs(), { env, cwd: dirs.cwd });
    expect(result.code, result.stderr).toBe(0);
    const seen = readMarker();
    for (const entry of entries) expect(seen.env[entry.name], entry.name).toBe(sha(entry.value));
    expect(Object.keys(seen.env).filter((name) => name.startsWith("SECRETS_"))).toEqual([]);
    expect(Object.values(seen.env)).not.toContain(sha(env.SECRETS_MACHINE_TOKEN ?? ""));
    expect(seen.starts).toBe(1);
    expect(seen.argv).toEqual([]);
    expect(allEmpty()).toBe(true);
  });

  it("nothing starts on anything less than the complete set", async () => {
    const good = goodResolve();
    const whole = Buffer.from(JSON.stringify(good), "utf8");
    const entries = good.entries as { name: string; value: string }[];
    const json = (body: unknown): Reply => ({ status: 200, body });
    const cases: [string, Reply, number][] = [
      [
        "cut at a JSON boundary",
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiMajor: 1, count: 3 }),
        },
        65,
      ],
      [
        "closed before content-length",
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(whole.length + 20),
          },
          body: whole,
        },
        69,
      ],
      ["count wrong", json({ ...good, count: 4 }), 65],
      ["complete false", json({ ...good, complete: false }), 65],
      [
        "complete absent",
        json(Object.fromEntries(Object.entries(good).filter(([key]) => key !== "complete"))),
        65,
      ],
      [
        "a duplicate name",
        json({ ...good, count: 3, entries: [entries[0], entries[0], entries[1]] }),
        65,
      ],
      [
        "an entry without a value",
        json({ ...good, entries: [{ name: entries[0]?.name }, entries[1], entries[2]] }),
        65,
      ],
      [
        "a 200 with HTML",
        { status: 200, headers: { "content-type": "text/html" }, body: "<html>login</html>" },
        65,
      ],
      ["a 200 with {}", json({}), 65],
      ["another apiMajor in the body", json({ ...good, apiMajor: 2 }), 65],
      ["a redirect", { status: 302, headers: { location: "https://127.0.0.1:1/x" } }, 69],
      ["401", errorReply(401, "unauthenticated").reply, 77],
      ["403", errorReply(403, "action_denied").reply, 77],
      ["404", errorReply(404, "not_found").reply, 77],
      ["409 environment_changed", errorReply(409, "environment_changed").reply, 69],
      ["409 key_under_review", errorReply(409, "key_under_review").reply, 69],
      ["429", errorReply(429, "rate_limited").reply, 75],
      ["503 busy", errorReply(503, "busy").reply, 75],
      ["503 backend_sealed", errorReply(503, "backend_sealed").reply, 69],
      ["503 quarantined", errorReply(503, "quarantined").reply, 69],
      ["507", errorReply(507, "capacity_exceeded").reply, 75],
    ];
    for (const [label, reply, exit] of cases) {
      const server = await serve({ resolve: reply });
      const result = await runCli(runArgs(), { env: envOf(server), cwd: dirs.cwd });
      expect(result.code, `${label}: ${result.stderr}`).toBe(exit);
      expect(existsSync(marker), label).toBe(false);
      expect(allEmpty(), label).toBe(true);
      expect(result.stderr.includes("synthetic"), label).toBe(false);
    }
  });

  // AC-1.37 (FR-1.49, FR-1.79) and R5-2 (Run 8.6, D-68): each refusal of the
  // connection or of the runtime starts nothing, and sends no credential.
  it("an http URL, an untrusted certificate, a setting that changes trust and another API major each start nothing", async () => {
    const server = await serve();
    const newer = await serve({
      version: { status: 200, body: { ...goodVersion(), apiMajor: 2 } },
    });
    const cases: [string, Record<string, string>, CliServer, number][] = [
      ["an http URL", { SECRETS_API_URL: server.url.replace("https:", "http:") }, server, 78],
      ["no trust for the certificate", { SECRETS_CA_FILE: "" }, server, 69],
      ["NODE_EXTRA_CA_CERTS", { NODE_EXTRA_CA_CERTS: server.caPath }, server, 78],
      ["OPENSSL_CONF", { OPENSSL_CONF: "/dev/null" }, server, 78],
      [
        "SSL_CERT_FILE and SSL_CERT_DIR add no trust",
        { SECRETS_CA_FILE: "", SSL_CERT_FILE: server.caPath, SSL_CERT_DIR: base },
        server,
        69,
      ],
      ["NODE_TLS_REJECT_UNAUTHORIZED=0", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, server, 78],
      ["another API major", {}, newer, 76],
    ];
    for (const [label, extra, target, exit] of cases) {
      const before = target.requests.length;
      const result = await runCli(runArgs(), { env: envOf(target, extra), cwd: dirs.cwd });
      expect(result.code, `${label}: ${result.stderr}`).toBe(exit);
      expect(existsSync(marker), label).toBe(false);
      expect(allEmpty(), label).toBe(true);
      const sent = target.requests.slice(before);
      expect(
        sent.every((request) => request.path === "/v1/version"),
        label,
      ).toBe(true);
    }
  });

  // Gate review, Important 1: resolve shares the API's large-request gate (two
  // per process), so instances started together can meet 503 busy. A read has
  // no effect: the CLI asks again, a few times, before anything is started.
  it("503 busy is asked again before anything starts: busy twice then 200 → the child runs; busy every time → 75 after five requests", async () => {
    const busy = errorReply(503, "busy").reply;
    const resolves = (server: CliServer) =>
      server.requests.filter((request) => request.path.endsWith("/resolve")).length;
    const recovering = await serve({ resolve: [busy, busy, { status: 200, body: goodResolve() }] });
    const ran = await runCli(runArgs(), { env: envOf(recovering), cwd: dirs.cwd });
    expect(ran.code, ran.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(resolves(recovering)).toBe(3);
    rmSync(marker);
    const always = await serve({ resolve: busy });
    const refused = await runCli(runArgs(), { env: envOf(always), cwd: dirs.cwd });
    expect(refused.code).toBe(75);
    expect(existsSync(marker)).toBe(false);
    expect(resolves(always)).toBe(5);
    // Another refusal is never asked again.
    const sealed = await serve({ resolve: errorReply(503, "backend_sealed").reply });
    expect((await runCli(runArgs(), { env: envOf(sealed), cwd: dirs.cwd })).code).toBe(69);
    expect(resolves(sealed)).toBe(1);
  });

  it("the token is nowhere a child could find it by default", async () => {
    const server = await serve();
    const env = envOf(server, { CHILD_MODE: "wait" });
    const secret = env.SECRETS_MACHINE_TOKEN ?? "";
    const cli = startCli(runArgs(), { env, cwd: dirs.cwd, detached: true });
    await until("the child", () => existsSync(marker));
    const seen = readMarker();
    expect(Object.values(seen.env)).not.toContain(sha(secret));
    expect(Object.keys(seen.env).some((name) => name.startsWith("SECRETS_"))).toBe(false);
    const group = processGroupArgs(cli.pid);
    expect(group.length).toBeGreaterThanOrEqual(2);
    expect(group.some((args) => args.includes(secret))).toBe(false);
    writeFileSync(release, "");
    expect((await cli.result).code).toBe(0);
  });

  it("a collision fails with 64 and starts nothing; with --override the secret wins", async () => {
    const value = synthetic("home");
    const server = await serve({
      resolve: { status: 200, body: goodResolve([{ name: "HOME", value }]) },
    });
    const refused = await runCli(runArgs(), { env: envOf(server), cwd: dirs.cwd });
    expect(refused.code).toBe(64);
    expect(existsSync(marker)).toBe(false);
    const allowed = await runCli(runArgs([], ["--override"]), {
      env: envOf(server),
      cwd: dirs.cwd,
    });
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(readMarker().env.HOME).toBe(sha(value));
  });

  it("stdin belongs to the child", async () => {
    const server = await serve();
    const text = "first line\nsecond line\n";
    const result = await runCli(["run", "--project", PROJECT, "--env", ENV_NAME, "--", "cat"], {
      env: envOf(server),
      stdin: text,
      cwd: dirs.cwd,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(text);
  });

  it("arguments are not interpreted", async () => {
    const server = await serve();
    const result = await runCli(runArgs(["$(id)", ";", "*"]), {
      env: envOf(server),
      cwd: dirs.cwd,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(readMarker().argv).toEqual(["$(id)", ";", "*"]);
  });

  it("the child's status is the CLI's: 7 → 7, SIGKILL → 137", async () => {
    const server = await serve();
    expect(
      (await runCli(runArgs(), { env: envOf(server, { CHILD_EXIT: "7" }), cwd: dirs.cwd })).code,
    ).toBe(7);
    rmSync(marker);
    expect(
      (await runCli(runArgs(), { env: envOf(server, { CHILD_MODE: "kill9" }), cwd: dirs.cwd }))
        .code,
    ).toBe(137);
  });

  it("without a terminal each of SIGTERM, SIGINT, SIGHUP and SIGQUIT reaches the child exactly once", async () => {
    const server = await serve();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
      rmSync(marker, { force: true });
      rmSync(release, { force: true });
      const cli = start(server, runArgs(), { CHILD_MODE: "wait" });
      await until(`the child (${signal})`, () => existsSync(marker));
      cli.kill(signal);
      await until(`${signal} at the child`, () => readMarker().signals[signal] >= 1);
      await sleep(300);
      writeFileSync(release, "");
      const result = await cli.result;
      expect(result.code, signal).toBe(0);
      const seen = readMarker();
      expect(seen.signals, signal).toEqual({
        SIGINT: 0,
        SIGTERM: 0,
        SIGHUP: 0,
        SIGQUIT: 0,
        SIGUSR1: 0,
        SIGUSR2: 0,
        [signal]: 1,
      });
      expect(seen.starts).toBe(1);
    }
  });

  // Fixes review F-3 (Run 8.6): SSL_CERT_FILE is the application's setting
  // (curl, Python); the CLI ignores it and passes it on.
  it("SSL_CERT_FILE set machine-wide reaches the child, and the run starts", async () => {
    const server = await serve();
    rmSync(marker, { force: true });
    const result = await runCli(runArgs(), {
      env: envOf(server, { SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt" }),
      cwd: dirs.cwd,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(readMarker().env.SSL_CERT_FILE).toBe(sha("/etc/ssl/certs/ca-certificates.crt"));
  });

  // R5-3 (Run 8.6): the CLI holds the token while the child runs, so SIGUSR1
  // must never open Node's inspector in it (the launcher's --disable-sigusr1).
  // Node then keeps SIGUSR1 blocked: the CLI neither dies nor passes it on (a
  // stated limit). SIGUSR2 (a supervisor's reload) is the child's: passed on once.
  it("SIGUSR1 opens no debugger and ends nothing; SIGUSR2 reaches the child exactly once", async () => {
    const server = await serve();
    rmSync(marker, { force: true });
    rmSync(release, { force: true });
    let cli = start(server, runArgs(), { CHILD_MODE: "wait" });
    await until("the child (SIGUSR1)", () => existsSync(marker));
    cli.kill("SIGUSR1");
    await sleep(1_000);
    expect(cli.peek().exited).toBe(false);
    writeFileSync(release, "");
    let result = await cli.result;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.includes("Debugger")).toBe(false);
    expect(readMarker().signals.SIGUSR1).toBe(0);

    rmSync(marker, { force: true });
    rmSync(release, { force: true });
    cli = start(server, runArgs(), { CHILD_MODE: "wait" });
    await until("the child (SIGUSR2)", () => existsSync(marker));
    cli.kill("SIGUSR2");
    await until("SIGUSR2 at the child", () => readMarker().signals.SIGUSR2 >= 1);
    await sleep(300);
    writeFileSync(release, "");
    result = await cli.result;
    expect(result.code, result.stderr).toBe(0);
    expect(readMarker().signals.SIGUSR2).toBe(1);
    expect(readMarker().starts).toBe(1);
  });

  // R5-4 (Run 8.6): the size check asks getconf by its absolute path and with
  // an empty environment, so nothing found through PATH ever sees the token.
  it("a getconf ahead in PATH is never run", async () => {
    const server = await serve();
    const bin = join(base, "bin");
    mkdirSync(bin);
    const seen = join(base, "markers", "getconf-ran");
    writeFileSync(
      join(bin, "getconf"),
      ["#!/bin/sh", `env > '${seen}'`, "echo 262144", ""].join("\n"),
      { mode: 0o755 },
    );
    // Control: the fake runs where it is, and leaves its mark.
    execFileSync(join(bin, "getconf"), ["ARG_MAX"], { env: {} });
    expect(existsSync(seen)).toBe(true);
    rmSync(seen);
    const result = await runCli(runArgs(), {
      env: envOf(server, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }),
      cwd: dirs.cwd,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(seen)).toBe(false);
  });

  it("a child that handles SIGTERM and exits 5 → 5; one that dies by it → 143", async () => {
    const server = await serve();
    const handled = start(server, runArgs(), { CHILD_MODE: "term5" });
    await until("the child", () => existsSync(marker));
    handled.kill("SIGTERM");
    expect((await handled.result).code).toBe(5);
    rmSync(marker);
    const dies = start(server, runArgs(), { CHILD_MODE: "termdie" });
    await until("the child", () => existsSync(marker));
    dies.kill("SIGTERM");
    expect((await dies.result).code).toBe(143);
  });

  it("with a terminal, Ctrl-C reaches the child once", async () => {
    const server = await serve();
    const cli = start(
      server,
      runArgs(),
      { CHILD_MODE: "wait" },
      { keepStdinOpen: true, through: underTerminal },
    );
    await until("the child", () => existsSync(marker) || cli.peek().exited).catch(() => undefined);
    if (!existsSync(marker)) {
      // Say why (the macOS runners hit this in the matrix): the wrapper's state and output.
      const seen = cli.peek();
      cli.kill("SIGKILL");
      throw new Error(
        `no child under the terminal; wrapper ${seen.exited ? "exited" : "still running"}; stdout ${JSON.stringify(seen.stdout.slice(-600))}; stderr ${JSON.stringify(seen.stderr.slice(-600))}`,
      );
    }
    cli.write("\u0003");
    await until("SIGINT at the child", () => readMarker().signals.SIGINT >= 1);
    await sleep(500);
    writeFileSync(release, "");
    const result = await cli.result;
    expect(result.code).toBe(0);
    expect(readMarker().signals).toEqual({
      SIGINT: 1,
      SIGTERM: 0,
      SIGHUP: 0,
      SIGQUIT: 0,
      SIGUSR1: 0,
      SIGUSR2: 0,
    });
  });

  it("a signal before the spawn starts nothing: SIGINT while resolve is pending → 130", async () => {
    const server = await serve({ resolve: "hang" });
    const cli = start(server, runArgs());
    await until("the resolve request", () =>
      server.requests.some((request) => request.path.endsWith("/resolve")),
    );
    cli.kill("SIGINT");
    expect((await cli.result).code).toBe(130);
    expect(existsSync(marker)).toBe(false);
  });

  it("too large for the platform → 75, nothing started", async () => {
    const entries =
      process.platform === "linux"
        ? [{ name: "BIG", value: "x".repeat(200 * 1024) }]
        : Array.from({ length: 20 }, (_, index) => ({
            name: `BIG_${String(index)}`,
            value: "x".repeat(100 * 1024),
          }));
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const result = await runCli(runArgs(), { env: envOf(server), cwd: dirs.cwd });
    expect(result.code).toBe(75);
    expect(existsSync(marker)).toBe(false);
  });

  it("a command that does not exist → 64; a child that exits 1 was started once", async () => {
    const server = await serve();
    const missing = await runCli(
      ["run", "--project", PROJECT, "--env", ENV_NAME, "--", join(base, "no-such-command")],
      { env: envOf(server), cwd: dirs.cwd },
    );
    expect(missing.code).toBe(64);
    const once = await runCli(runArgs(), {
      env: envOf(server, { CHILD_EXIT: "1" }),
      cwd: dirs.cwd,
    });
    expect(once.code).toBe(1);
    expect(readMarker().starts).toBe(1);
    expect(server.requests.filter((request) => request.path.endsWith("/resolve"))).toHaveLength(2);
  });
});

/** The argument lists of every process in a process group: /proc on Linux, ps on macOS. */
function processGroupArgs(pgid: number): string[] {
  if (process.platform === "linux") {
    const found: string[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) !== pgid) continue;
        found.push(readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " "));
      } catch {
        // The process ended while it was read.
      }
    }
    return found;
  }
  const listed = execFileSync("ps", ["-o", "args=", "-g", String(pgid)], { encoding: "utf8" });
  return listed.split("\n").filter((line) => line.trim() !== "");
}
