// The child `secrets run` starts in tests/cli/run.test.ts. It writes into the
// marker file (its first argument) what it was given: the names of its
// environment with the SHA-256 of each value (never a value), its arguments,
// how many times it was started, and how many of each signal it received.
// CHILD_MODE: exit (default) | wait | kill9 | term5 | termdie; CHILD_EXIT is
// the status of `exit` and `wait`; `wait` ends when CHILD_RELEASE exists.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

const [marker, ...rest] = process.argv.slice(2);
const mode = process.env.CHILD_MODE ?? "exit";
const status = Number(process.env.CHILD_EXIT ?? "0");
const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : { starts: 0 };
const state = {
  starts: previous.starts + 1,
  pid: process.pid,
  argv: rest,
  env: Object.fromEntries(
    Object.entries(process.env).map(([name, value]) => [
      name,
      createHash("sha256")
        .update(value ?? "", "utf8")
        .digest("hex"),
    ]),
  ),
  signals: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, SIGQUIT: 0, SIGUSR1: 0, SIGUSR2: 0 },
};
const save = () => {
  writeFileSync(`${marker}.tmp`, JSON.stringify(state));
  renameSync(`${marker}.tmp`, marker);
};

const count = (signal) => () => {
  state.signals[signal] += 1;
  save();
  if (mode === "term5" && signal === "SIGTERM") process.exit(5);
};
for (const signal of ["SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR2"]) process.on(signal, count(signal));
// R5-3: counted, so a test can show the CLI does not pass SIGUSR1 on.
process.on("SIGUSR1", count("SIGUSR1"));
if (mode !== "termdie") process.on("SIGTERM", count("SIGTERM"));
save();

if (mode === "kill9") process.kill(process.pid, "SIGKILL");
if (mode === "exit") process.exit(status);

const release = process.env.CHILD_RELEASE;
const deadline = Date.now() + 30_000;
const timer = setInterval(() => {
  if ((release !== undefined && existsSync(release)) || Date.now() > deadline) {
    clearInterval(timer);
    process.exit(status);
  }
}, 25);
