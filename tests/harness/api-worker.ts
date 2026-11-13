// A real second API process for tests that need two (Run 3.3): throttling,
// one-use steps and reset links must hold across processes, as on a host with
// two API containers (LIMITS.concurrency.apiProcesses).
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ApiConfig } from "@mykey/api";
import type { DbTarget } from "@mykey/db";

const ENTRY = resolve(import.meta.dirname, "api-process.ts");

export interface ApiProcess {
  baseUrl: string;
  port: number;
  pid: number;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts one API process on `database` (as api_runtime) with the key files of
 * `keysDirectory`, the gate file and host id of `api`, and the stack's API
 * certificate. Resolves when it listens.
 */
export function startApiProcess(
  database: DbTarget,
  opts: {
    keysDirectory: string;
    api: ApiConfig;
    tls: { certPath: string; keyPath: string };
  },
): Promise<ApiProcess> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const exited = new Promise<void>((resolveExit) =>
      child.once("exit", () => {
        resolveExit();
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.once("exit", (code) => {
      reject(
        new Error(
          `the API process exited (${String(code)}) before listening: ${errors.slice(-500)}`,
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n")[0];
      if (line === undefined || !output.includes("\n")) return;
      const { port } = JSON.parse(line) as { port: number };
      resolveStart({
        port,
        baseUrl: `https://127.0.0.1:${String(port)}`,
        pid: child.pid ?? -1,
        async kill(signal) {
          if (child.exitCode !== null) return;
          if (signal === undefined) child.stdin.end("stop\n");
          else child.kill(signal);
          await exited;
        },
      });
    });
    child.stdin.write(
      `${JSON.stringify({ database, keysDirectory: opts.keysDirectory, api: opts.api, tls: opts.tls })}\n`,
    );
  });
}

const PROVISIONER_ENTRY = resolve(import.meta.dirname, "provisioner-process.ts");

export interface ProvisionerProcess {
  pid: number;
  /** Every log line so far (parsed). */
  logs: Record<string, unknown>[];
  /** Resolves when the process has exited; its exit code. */
  exited: Promise<number | null>;
  /** SIGKILL. */
  kill(): Promise<void>;
  /** A clean stop. */
  stop(): Promise<void>;
  /** Asks for one sweep now; resolves when its log line arrives. */
  sweep(): Promise<void>;
}

/**
 * Starts the provisioner as a child process on `database` (as
 * provisioner_runtime) with the stack's OpenBao and a credential directory
 * that holds `organizationId` and the provisioner's role id and secret id.
 */
export function startProvisionerProcess(
  database: DbTarget,
  opts: {
    openBao: { url: string; caCertPath: string };
    secretsDirectory: string;
    gatePath: string;
    hostInstanceId: string;
    stateFile: string;
    sweepSeconds?: number;
    crashAt?: string;
  },
): Promise<ProvisionerProcess> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [PROVISIONER_ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    const logs: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    let errors = "";
    let buffered = "";
    const exited = new Promise<number | null>((resolveExit) =>
      child.once("exit", (code) => {
        resolveExit(code);
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("error", reject);
    void exited.then((code) => {
      reject(
        new Error(
          `the provisioner exited (${String(code)}) before starting: ${errors.slice(-500)}`,
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let end = buffered.indexOf("\n");
      while (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf("\n");
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.started === true) {
          resolveStart(handle);
          continue;
        }
        logs.push(entry);
        if (entry.event === "sweep" || entry.event === "sweep_skipped") {
          for (const wake of waiters.splice(0)) wake();
        }
      }
    });
    const handle: ProvisionerProcess = {
      pid: child.pid ?? -1,
      logs,
      exited,
      async kill() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdin.write("stop\n");
        await exited;
      },
      sweep() {
        return new Promise((resolveSweep) => {
          waiters.push(resolveSweep);
          child.stdin.write("sweep\n");
        });
      },
    };
    child.stdin.write(
      `${JSON.stringify({
        config: {
          database,
          openBao: opts.openBao,
          secretsDirectory: opts.secretsDirectory,
          gatePath: opts.gatePath,
          hostInstanceId: opts.hostInstanceId,
          sweepSeconds: opts.sweepSeconds ?? 3600,
          stateFile: opts.stateFile,
        },
        ...(opts.crashAt === undefined ? {} : { crashAt: opts.crashAt }),
      })}\n`,
    );
  });
}
