// Run 2.8: sets up one synthetic organization on the dev stack and runs run.sh
// in a container from the pinned OpenBao image on the stack's network.
// Run: node tests/fixtures/agent-spike/drive.ts
// Prints only run.sh's observation lines; tokens travel in a temporary
// directory outside the repository and are never printed.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { environmentPrefix, OpenBaoClient, secretPath } from "@mykey/openbao";
import { createOrgFixture } from "../../harness/org-fixture.ts";
import { DEV_PROJECT, startStack } from "../../harness/stack.ts";

const run = promisify(execFile);
const HERE = resolve(import.meta.dirname);
const IMAGE =
  "openbao/openbao@sha256:5046911075e137e154ce49ab051502f4ec7cf367d484ae4a4dce665d9b90561f";

// The dev stack stays up afterwards (`pnpm run stack:down` stops it); removing it would delete its volumes.
const stack = await startStack({ project: DEV_PROJECT, fixedPorts: true });
const org = await createOrgFixture(stack, { environments: 1 });
const directory = mkdtempSync(join(tmpdir(), "mykey-agent-spike-"));
try {
  const environment = org.environments[0];
  if (environment === undefined) throw new Error("no environment");
  const runtimeToken = await org.login("runtime");
  const runtime = new OpenBaoClient(stack.bao, { namespace: org.namespace, token: runtimeToken });
  const write = async (name: string, value: string, cas: number): Promise<void> => {
    const c = { operationId: randomUUID(), dispatchId: randomUUID() };
    const result = await runtime.kvWrite(
      secretPath(org.projectId, environment.id, name),
      { value, operation_id: c.operationId, format: 1 },
      cas,
      c,
    );
    if (!result.ok) throw new Error(`write ${name}: ${result.kind}`);
  };
  await write("A_ONE", "synthetic-one-v1", 0);
  await write("A_ONE", "synthetic-one-v2", 1);
  await write("A_TWO", "synthetic-two-v1", 0);

  const root = new OpenBaoClient(stack.bao, { namespace: org.namespace, token: stack.bao.rootToken });
  const issued = await root.tokenCreateFromRole(environment.machineName, 900, {
    operationId: randomUUID(),
    dispatchId: randomUUID(),
  });
  if (!issued.ok) throw new Error(`machine token: ${issued.kind}`);
  writeFileSync(join(directory, "token"), issued.data.token, { mode: 0o644 });
  writeFileSync(join(directory, "runtime-token"), runtimeToken, { mode: 0o644 });
  copyFileSync(stack.bao.caCertPath, join(directory, "ca.crt"));

  const prefix = environmentPrefix(org.projectId, environment.id).replace(/\/$/, "");
  const { stdout } = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `${DEV_PROJECT}_default`,
      "-v",
      `${HERE}:/spike:ro`,
      "-v",
      `${directory}:/run/spike:ro`,
      "-e",
      `BAO_NAMESPACE=${org.namespace}`,
      "-e",
      `PREFIX=${prefix}`,
      "--entrypoint",
      "sh",
      IMAGE,
      "/spike/run.sh",
    ],
    { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
  );
  process.stdout.write(stdout);
} finally {
  rmSync(directory, { recursive: true, force: true });
  await org.drop();
}
