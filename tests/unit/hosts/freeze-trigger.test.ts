// Run 10.3 (P-176, D-78): the credential drill's trigger. On the host it
// follows OpenBao's audit device and freezes OpenBao's control group at the
// request record of one environment's token create, which OpenBao writes
// before it handles the request. Here it runs against temporary files with
// synthetic records of OpenBao's shape: what fires, what does not, and that
// the freeze file always ends at 0.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../staging/host-scripts/freeze-on-create.sh");
const ENV = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const OTHER = "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b";

const record = (type: "request" | "response", environment: string): string =>
  `${JSON.stringify({
    time: new Date().toISOString(),
    type,
    auth: { client_token: "hmac-sha256:00" },
    request: {
      id: "r-1",
      operation: "update",
      namespace: { id: "n1", path: "org-1/" },
      path: `auth/token/create/machine-env-${environment}`,
    },
  })}\n`;

interface Run {
  freeze: string;
  log: string;
  done: Promise<{ code: number | null; out: string }>;
  kill: () => void;
}

/**
 * Starts the script. With `termWhenFrozen`, a bash parent sends it SIGTERM as
 * soon as the freeze file reads 1, as systemd stops a unit: a signal sent from
 * this process would not be one on Windows.
 */
async function start(hold: number, arm: number, termWhenFrozen = false): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "mykey-freeze-"));
  const log = join(dir, "audit.log");
  const freeze = join(dir, "cgroup.freeze");
  writeFileSync(log, record("request", ENV));
  writeFileSync(freeze, "0\n");
  const args = [SCRIPT, ENV, String(hold), String(arm)];
  const wrapped = [
    "-c",
    'bash "$@" & p=$!; until [ "$(cat "$FREEZE_FILE")" = 1 ]; do sleep 0.05; done; kill -TERM "$p"; wait "$p"',
    "wrapper",
    ...args,
  ];
  const child = spawn("bash", termWhenFrozen ? wrapped : args, {
    env: { ...process.env, AUDIT_LOG: log, FREEZE_FILE: freeze },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const done = new Promise<{ code: number | null; out: string }>((resolveDone) => {
    child.on("close", (code) => {
      resolveDone({ code, out });
    });
  });
  for (const deadline = Date.now() + 10_000; !out.includes("armed ");) {
    if (Date.now() > deadline) throw new Error(`never armed: ${out}`);
    await sleep(20);
  }
  return { freeze, log, done, kill: () => child.kill("SIGTERM") };
}

const frozen = (run: Run): string => readFileSync(run.freeze, "utf8").trim();

async function until(what: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (what()) return true;
    await sleep(10);
  }
  return what();
}

describe("the credential drill's trigger (freeze-on-create.sh)", () => {
  it("a response record of the path, and a request record of another environment, do not fire; a record from before it armed does not either", async () => {
    const run = await start(1, 2);
    appendFileSync(run.log, record("response", ENV));
    appendFileSync(run.log, record("request", OTHER));
    expect(await until(() => frozen(run) === "1", 800)).toBe(false);
    const { code } = await run.done;
    expect(code).toBe(3);
    expect(frozen(run)).toBe("0");
  }, 20_000);

  it("the request record of this environment fires: the freeze file reads 1 within 200 ms, and 0 after the hold", async () => {
    const run = await start(1, 10);
    const written = Date.now();
    appendFileSync(run.log, record("request", ENV));
    expect(await until(() => frozen(run) === "1", 200)).toBe(true);
    expect(Date.now() - written).toBeLessThan(400);
    const { code, out } = await run.done;
    expect(code).toBe(0);
    expect(frozen(run)).toBe("0");
    expect(out).toMatch(/^matched \d+$/m);
  }, 20_000);

  it("killed while holding, the freeze file reads 0 at once, not after the hold", async () => {
    const run = await start(30, 10, true);
    const written = Date.now();
    appendFileSync(run.log, record("request", ENV));
    const { code } = await run.done;
    expect(code).toBe(143);
    expect(Date.now() - written).toBeLessThan(5_000);
    expect(frozen(run)).toBe("0");
  }, 20_000);

  it("nothing matched in the arm time: exit 3, and the freeze file reads 0", async () => {
    const run = await start(1, 1);
    const { code, out } = await run.done;
    expect(code).toBe(3);
    expect(frozen(run)).toBe("0");
    expect(out).not.toContain("matched");
  }, 20_000);

  it("the output is four lines of a word and a number, and holds nothing of any audit line", async () => {
    const run = await start(1, 10);
    appendFileSync(run.log, record("request", ENV));
    const { out } = await run.done;
    const lines = out.trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "armed",
      "matched",
      "frozen",
      "thawed",
    ]);
    for (const line of lines) expect(line).toMatch(/^[a-z]+ \d+$/);
    expect(out).not.toContain("machine-env");
  }, 20_000);
});
