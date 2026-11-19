// The provisioner process (Run 3.8, P-55): the job worker for
// `environment.provision` and the drift sweep timer. It reaches OpenBao only
// through `@mykey/openbao/provisioner`, never `/admin`.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LIMITS, type OperationId, type OrganizationId } from "@mykey/contracts";
import { captureMode, createPool } from "@mykey/db";
import { namespaceFor } from "@mykey/openbao";
import { ProvisionerClient } from "@mykey/openbao/provisioner";
import { createSender, createWorker, isCaptureRefusal, readGate } from "@mykey/operations";
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
  // Run 6.7 (P-122): the record must admit all, and OpenBao (the organization
  // namespace's copy) must name this incarnation; read again after 5 s.
  // A denied answer (Session 6 gate): OpenBao refused the provisioner's login
  // (a bad or destroyed secret id) or its read (its policy is gone). Either way
  // it can change nothing, so the job runs and fails into review
  // (provisioning_failed), and the sweep runs and reports the drift, instead of
  // both waiting for ever on a read they cannot make.
  // An unreachable OpenBao (Session 6 gate) proves nothing about which OpenBao
  // it is: the gate stays shut, as `unreachable` rather than `incarnation`, and
  // the failed read is not kept, so the first sweep after it returns reads again.
  interface BaoReading {
    value: string | null;
    denied: boolean;
    unanswered: boolean;
  }
  let baoIncarnation: BaoReading & { at: number } = {
    value: null,
    denied: false,
    unanswered: false,
    at: -Infinity,
  };
  const readBaoIncarnation = async (): Promise<BaoReading> => {
    if (Date.now() - baoIncarnation.at < 5_000) return baoIncarnation;
    let value: string | null = null;
    let denied = false;
    let unanswered = false;
    const organizationId = readCredential(config.secretsDirectory)?.organizationId;
    const client =
      organizationId === undefined ? null : await clientFor(organizationId as OrganizationId);
    if (client !== null) {
      try {
        const answer = await client.readIncarnation();
        value = answer.ok ? answer.value : null;
        denied = !answer.ok && answer.cause === "denied";
        unanswered = !answer.ok && !denied;
      } finally {
        await client.close();
      }
    }
    const reading = { value, denied, unanswered };
    if (!unanswered) baoIncarnation = { ...reading, at: Date.now() };
    return reading;
  };
  const expect = {
    hostInstanceId: config.hostInstanceId,
    backendIncarnation: config.backendIncarnation,
    releaseBuild: config.releaseBuild,
  };
  const gateCause = async (): Promise<string | null> => {
    const reading = readGate(config.gatePath, expect);
    if (reading.admits !== "all") return "gate_closed";
    const found = await readBaoIncarnation().catch(() => null);
    if (found === null || found.unanswered) return "unreachable";
    if (found.value === config.backendIncarnation) return null;
    return found.denied ? null : "incarnation";
  };
  const sender = await createSender(pool);
  // P-118: no job and no sweep while a pair is captured.
  const captured = async (): Promise<boolean> => (await captureMode(pool)).mode !== "idle";
  const later = async (operationId: OperationId, cause: string): Promise<void> => {
    opts.log({ event: "job_deferred", operationId, cause });
    await sender.send("environment.provision", operationId, {
      startAfterSeconds: GATE_RETRY_SECONDS,
    });
  };

  const worker = await createWorker(pool, {
    "environment.provision": async (operationId, meta) => {
      const closed = await gateCause();
      if (closed !== null) {
        // Nothing was done. The job comes back in 30 s without using a retry, so
        // a long closure (a deploy, a quarantine) never ends the job (gate review).
        await later(operationId, closed);
        return;
      }
      if (await captured()) {
        await later(operationId, "capture");
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
        // A capture began after the check: the barrier refused a write, so later.
        if (isCaptureRefusal(error)) {
          await later(operationId, "capture");
          return;
        }
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
    const closed = await gateCause();
    if (closed !== null) {
      opts.log({ event: "sweep_skipped", cause: closed });
    } else if (await captured().catch(() => true)) {
      opts.log({ event: "sweep_skipped", cause: "capture" });
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
