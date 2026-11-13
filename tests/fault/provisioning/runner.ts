// Run 3.8 Task B: runs `provisionOrganization` as a child process so a test can
// stop it for real at a point (exit 137, as a SIGKILL would). Reads one JSON
// job on stdin; appends each delivered credential to `deliveredFile` (the test
// stack's synthetic values, never printed); prints one JSON outcome line.
import { appendFileSync } from "node:fs";
import type { OrganizationId } from "@mykey/contracts";
import { createPool, type DbTarget } from "@mykey/db";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { provisionOrganization } from "@mykey/operations/operator";

export interface ProvisionJob {
  maintenance: DbTarget;
  bao: { url: string; caCertPath: string; rootToken: string };
  organizationId: string;
  crashAt?: string;
  run: number;
  deliveredFile: string;
}

let text = "";
for await (const chunk of process.stdin) text += String(chunk);
const job = JSON.parse(text) as ProvisionJob;

const pool = createPool(job.maintenance, { max: 3 });
const admin = new OpenBaoAdmin(
  { url: job.bao.url, caCertPath: job.bao.caCertPath },
  job.bao.rootToken,
);
const result = await provisionOrganization(
  {
    pool,
    admin,
    boundCidrs: { runtime: [], issuer: [], provisioner: [] },
    deliver: (name, credential) => {
      appendFileSync(
        job.deliveredFile,
        `${JSON.stringify({ run: job.run, name, ...credential })}\n`,
      );
      return Promise.resolve();
    },
    crashAt: (point) => {
      if (point === job.crashAt) process.exit(137);
    },
  },
  job.organizationId as OrganizationId,
);
process.stdout.write(`${JSON.stringify({ outcome: result.outcome })}\n`);
await pool.end();
