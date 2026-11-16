// The provisioner process (Run 3.8, P-55): the job worker for
// `environment.provision` and the drift sweep timer. It reaches OpenBao only
// through `@mykey/openbao/provisioner`, never `/admin`.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LIMITS, type OrganizationId } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { namespaceFor } from "@mykey/openbao";
import { ProvisionerClient } from "@mykey/openbao/provisioner";
import { createSender, createWorker, readGate } from "@mykey/operations";
import {
  provisionEnvironment,
  sweepAll,
  type EnvironmentDeps,
} from "@mykey/operations/provisioner";
import { readCredential, type ProvisionerConfig } from "./config.ts";

export type ProvisionerLog =
  | { event: "provisioner_start"; bootId: string; sweepSeconds: number }
  | { event: "job"; operationId: string; outcome: string }
  | { event: "job_deferred"; operationId: string; cause: string }
  | { event: "sweep"; reviewed: number; unread: number }
  | { event: "sweep_skipped"; cause: string }
  | { event: "error"; where: string; errorClass: string };

/** How long a job waits before it looks at a closed gate again. */
const GATE_RETRY_SECONDS = 30;

/** Run 6.3 (P-114): the provisioner's one pool, from LIMITS.db. */
export const PROVISIONER_CONNECTIONS = LIMITS.db.provisionerPool;

export interface StartOptions {
  log: (entry: ProvisionerLog) => void;
  /** Test-only: stops the process at a point of the environment job. */
  crashAt?: (point: string) => void;
  bootId?: string;
}

export async function startProvisioner(
  config: ProvisionerConfig,
  opts: StartOptions,
): Promise<{ stop(): Promise<void>; sweepNow(): Promise<void> }> {
  const bootId = opts.bootId ?? randomUUID();
  const pool = createPool(config.database, { max: PROVISIONER_CONNECTIONS });
  const clientFor: EnvironmentDeps["clientFor"] = (organizationId: OrganizationId) => {
    const credential = readCredential(config.secretsDirectory);
    if (credential?.organizationId !== organizationId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      new ProvisionerClient(config.openBao, namespaceFor(organizationId), {
        roleId: credential.roleId,
        secretId: credential.secretId,
      }),
    );
  };
  const gateOpen = () => readGate(config.gatePath, config.hostInstanceId).open;
  const sender = await createSender(pool);

  const worker = await createWorker(pool, {
    "environment.provision": async (operationId, meta) => {
      if (!gateOpen()) {
        opts.log({ event: "job_deferred", operationId, cause: "gate_closed" });
        // Nothing was done. The job comes back in 30 s without using a retry, so
        // a long closure (a deploy, a quarantine) never ends the job (gate review).
        await sender.send("environment.provision", operationId, {
          startAfterSeconds: GATE_RETRY_SECONDS,
        });
        return;
      }
      try {
        const outcome = await provisionEnvironment(
          {
            pool,
            clientFor,
            bootId,
            lastAttempt: meta.lastAttempt,
            ...(opts.crashAt === undefined ? {} : { crashAt: opts.crashAt }),
          },
          operationId,
        );
        opts.log({ event: "job", operationId, outcome });
      } catch (error) {
        opts.log({
          event: "job_deferred",
          operationId,
          cause: error instanceof Error ? error.constructor.name : "error",
        });
        throw error;
      }
    },
  });

  const sweep = async (): Promise<void> => {
    if (!gateOpen()) {
      opts.log({ event: "sweep_skipped", cause: "gate_closed" });
    } else {
      try {
        const result = await sweepAll({ pool, clientFor });
        opts.log({ event: "sweep", reviewed: result.reviewed.length, unread: result.unread });
      } catch (error) {
        opts.log({
          event: "error",
          where: "sweep",
          errorClass: error instanceof Error ? error.constructor.name : "error",
        });
        return;
      }
    }
    try {
      mkdirSync(dirname(config.stateFile), { recursive: true });
      writeFileSync(config.stateFile, new Date().toISOString());
    } catch (error) {
      // The health check then reports unhealthy; the process keeps working.
      opts.log({
        event: "error",
        where: "sweep_state",
        errorClass: error instanceof Error ? error.constructor.name : "error",
      });
    }
  };

  let running: Promise<void> = sweep();
  const timer = setInterval(() => {
    running = running.then(sweep);
  }, config.sweepSeconds * 1000);
  opts.log({ event: "provisioner_start", bootId, sweepSeconds: config.sweepSeconds });

  return {
    sweepNow: () => (running = running.then(sweep)),
    async stop() {
      clearInterval(timer);
      await running;
      await worker.stop();
      await sender.stop();
      await pool.end();
    },
  };
}
