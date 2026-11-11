// THROW-AWAY (Run 2.4). Runs one executeWrite as a child process, so a test
// can kill it for real (SIGKILL at a boundary, or from outside while it hangs).
// Reads one JSON job on stdin, prints one JSON outcome line on stdout.
import { randomUUID } from "node:crypto";
import { createPool, type DbTarget } from "@mykey/db";
import { OpenBaoClient } from "@mykey/openbao";
import { executeWrite, type Boundary, type SpikeWrite } from "./executor.ts";

export interface RunnerJob {
  runtime: DbTarget;
  lock: DbTarget;
  bao: { url: string; caCertPath: string; namespace: string; token: string; deadlineMs?: number };
  bootId?: string;
  crashAt?: Boundary;
  hangAfterSend?: boolean;
  input: SpikeWrite;
}

let text = "";
for await (const chunk of process.stdin) text += String(chunk);
const job = JSON.parse(text) as RunnerJob;

const runtimePool = createPool(job.runtime, { max: 2 });
// A hanging executor keeps its socket: its client never gives up on its own.
const deadlineMs = job.hangAfterSend === true ? 600_000 : job.bao.deadlineMs;
const bao = new OpenBaoClient(
  { url: job.bao.url, caCertPath: job.bao.caCertPath },
  {
    namespace: job.bao.namespace,
    token: job.bao.token,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  },
);
process.stdout.write(`${JSON.stringify({ started: true, pid: process.pid })}\n`);
const outcome = await executeWrite(
  {
    runtimePool,
    lockTarget: job.lock,
    bao,
    bootId: job.bootId ?? randomUUID(),
    ...(job.crashAt === undefined ? {} : { crashAt: job.crashAt }),
    ...(job.hangAfterSend === undefined ? {} : { hangAfterSend: job.hangAfterSend }),
  },
  job.input,
);
process.stdout.write(`${JSON.stringify({ outcome })}\n`);
await runtimePool.end();
process.exit(0);
