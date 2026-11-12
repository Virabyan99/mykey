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
