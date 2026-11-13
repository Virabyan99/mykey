// The child side of `startProvisionerProcess` (Run 3.8): reads one JSON line
// with the provisioner's settings, starts it, prints `{"started":true}`, and
// relays its log lines. `stop` on stdin stops it cleanly; a crash point exits 137.
import { createInterface } from "node:readline";
import { startProvisioner, type ProvisionerConfig } from "@mykey/provisioner";

const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
const job = JSON.parse(String(first.value)) as { config: ProvisionerConfig; crashAt?: string };
const provisioner = await startProvisioner(job.config, {
  log: (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  },
  ...(job.crashAt === undefined
    ? {}
    : {
        crashAt: (point: string) => {
          if (point === job.crashAt) process.exit(137);
        },
      }),
});
process.stdout.write(`${JSON.stringify({ started: true })}\n`);
for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
  if (line === "stop") {
    await provisioner.stop();
    process.exit(0);
  }
  if (line === "sweep") await provisioner.sweepNow();
}
