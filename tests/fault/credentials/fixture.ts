// The fault table of machine credentials (Run 5.2 Task B, AC-1.40): the
// credentials fixture with two API processes — the in-process one and a child
// that really dies (a fault `crash` is SIGKILL inside the hook) — both reaching
// OpenBao through the TLS relay. The helpers settle as the operator does: the
// sweep, then `ops reconcile-credentials` as `maintenance`.
//
// Tokens are compared by booleans and counts only; the command's output is
// searched for accessors by boolean.
import { PassThrough } from "node:stream";
import { sweepCredentials } from "@mykey/operations";
import { runOps } from "@mykey/ops";
import { expect } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
  machineAccessors,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { Answer, EnvName } from "../../harness/secrets-fixture.ts";

export interface CredentialFaults {
  f: CredentialsFixture;
  /** Restarts the child process with `crash` at `point` (or with no fault). */
  child(point?: string): Promise<void>;
  /** A request to the child that dies: null when no answer came back. */
  toChild(send: () => Promise<Answer>): Promise<Answer | null>;
  /** The operation of an idempotency key (the client of a dead process got no id). */
  operationByKey(key: string): Promise<string | null>;
  operation(id: string): Promise<{ state: string; error_code: string | null } | null>;
  /** The credential row an issuance wrote. */
  credentialOf(operationId: string): Promise<{ id: string; state: string } | null>;
  stateOf(credentialId: string): Promise<string | undefined>;
  /** The executor's heartbeat aged past the stale time, then the sweep. */
  sweepAfterStale(operationId: string): Promise<void>;
  reconcile(env: EnvName, excluded?: boolean): Promise<{ code: number; out: string }>;
  /** Machine tokens OpenBao holds for the environment. */
  tokens(env: EnvName): Promise<{ accessor: string; meta: Record<string, string> | null }[]>;
  /** lookup-self with the token: true while OpenBao accepts it. */
  alive(token: string): Promise<boolean>;
  /** Polls the credential's state every 25 ms until stopped; answers what it saw, in order. */
  watch(credentialId: string): { stop(): Promise<string[]> };
  /** The invariant every case ends with, then the environment cleared. */
  finish(env: EnvName): Promise<void>;
  /** After each case, whatever it left: faults off, the relay passing, the environments cleared. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function credentialFaults(): Promise<CredentialFaults> {
  const f = await createCredentialsFixture({ processes: 2 });
  const q = f.api.superuser;
  const envId = (env: EnvName) => f.env(env).environmentId;

  const faults: CredentialFaults = {
    f,
    async child(point) {
      // A request the child still holds would keep a clean stop waiting.
      await f.second?.kill("SIGKILL");
      await f.restartSecond(point === undefined ? undefined : { point, action: "crash" });
    },
    async toChild(send) {
      return send().catch(() => null);
    },
    async operationByKey(key) {
      const row = await q.query<{ id: string }>(
        "SELECT id FROM app.operation WHERE idempotency_key = $1",
        [key],
      );
      return row.rows[0]?.id ?? null;
    },
    async operation(id) {
      const row = await q.query<{ state: string; error_code: string | null }>(
        "SELECT state, error_code FROM app.operation WHERE id = $1",
        [id],
      );
      return row.rows[0] ?? null;
    },
    async credentialOf(operationId) {
      const row = await q.query<{ id: string; state: string }>(
        "SELECT id, state FROM app.machine_credential WHERE issuance_operation_id = $1",
        [operationId],
      );
      return row.rows[0] ?? null;
    },
    async stateOf(credentialId) {
      const row = await q.query<{ state: string }>(
        "SELECT state FROM app.machine_credential WHERE id = $1",
        [credentialId],
      );
      return row.rows[0]?.state;
    },
    async sweepAfterStale(operationId) {
      await q.query(
        "UPDATE app.operation SET heartbeat_at = now() - interval '121 seconds' WHERE id = $1",
        [operationId],
      );
      await sweepCredentials(f.api.pool);
    },
    async reconcile(env, excluded = false) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = "";
      stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
      stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
      const stdin = new PassThrough();
      stdin.end();
      const accessors = (await machineAccessors(f, envId(env))).map((t) => t.accessor);
      const code = await runOps(
        [
          "reconcile-credentials",
          "--environment",
          envId(env),
          ...(excluded ? ["--executors-excluded", "yes"] : []),
        ],
        {
          stdin,
          stdout,
          stderr,
          env: {
            database: f.api.database.targets.maintenance,
            openBao: { target: f.stack.bao, rootToken: f.stack.bao.rootToken },
          },
        },
      );
      expect(
        accessors.some((accessor) => out.includes(accessor)),
        "an accessor in the output",
      ).toBe(false);
      return { code, out };
    },
    tokens: (env) => machineAccessors(f, envId(env)),
    async alive(token) {
      const answer = await baoAnswer(f.stack, token, "GET", "auth/token/lookup-self", {
        namespace: f.fx.namespace,
      });
      return answer.status === 200;
    },
    watch(credentialId) {
      const seen: string[] = [];
      const control = { running: true };
      const loop = (async () => {
        while (control.running) {
          const state = await faults.stateOf(credentialId);
          if (state !== undefined && seen.at(-1) !== state) seen.push(state);
          await sleep(25);
        }
      })();
      return {
        async stop() {
          control.running = false;
          await loop;
          return seen;
        },
      };
    },
    async finish(env) {
      f.setFaults(null);
      f.relay.clear();
      await expectCatalogMatchesBackend(f, envId(env));
      await clearCredentials(f, envId(env));
    },
    async reset() {
      f.setFaults(null);
      f.relay.clear();
      for (const env of ["env1a", "env1b", "env2a"] as const) await clearCredentials(f, envId(env));
    },
    async close() {
      await f.close();
    },
  };
  return faults;
}
