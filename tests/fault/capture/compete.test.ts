// Run 6.5 Task B (P-118, P-120, Review focus 1): forty captures in a row
// against everything at once. Eight workers run without pause (secret writes
// and deletes, imports, issuance and revocation, archive and reactivation,
// project and environment creation with real provisioner jobs, sign-in with
// TOTP and session activity, password change, machine resolves). Every pair
// that ends eligible is restored into scratch instances and must agree with
// itself: the catalog and OpenBao hold the same machine tokens, nothing is
// executing, no effect slot is held, the auth rows are whole. Every pair a
// reduction crossed is ineligible (access_reduction) and the reduction
// succeeded. No worker ever gets a 5xx other than busy.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import { startOutboxDispatcher } from "@mykey/api";
import type { EnvironmentId } from "@mykey/contracts";
import { crossedByReduction, markEligible, markIneligible } from "@mykey/db";
import { machineName } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInComplete } from "../../harness/api.ts";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { archive, newProject, reactivate, type Place } from "../../harness/lifecycle-fixture.ts";
import { machineCall } from "../../harness/machine.ts";
import {
  pairRestorer,
  takePair,
  type PairRestorer,
  type PairSource,
  type RestoredPair,
  type TakenPair,
} from "../../harness/pair-fixture.ts";
import type { Stack } from "../../harness/stack.ts";

// MYKEY_COMPETE_CAPTURES runs fewer captures when diagnosing; the proof is 40.
const CAPTURES = Number(process.env.MYKEY_COMPETE_CAPTURES ?? "40");
const MINIMUM_OF_EACH = Math.min(5, Math.floor(CAPTURES / 4));
/** One line per step to MYKEY_COMPETE_LOG, so a slow run shows where it is. */
const started = Date.now();
function progress(message: string): void {
  const file = process.env.MYKEY_COMPETE_LOG;
  if (file === undefined) return;
  appendFileSync(
    file,
    `${String(Math.round((Date.now() - started) / 1000))}s ${message}
`,
  );
}

let f: CredentialsFixture;
let source: PairSource;
let restorer: PairRestorer;
let provisioner: { stop(): Promise<void> } | null = null;
let dispatcher: { stop(): Promise<void> } | null = null;
let places: Place[] = [];

beforeAll(async () => {
  f = await createCredentialsFixture({ stackOverrides: ["scratch-bao.override.yml"] });
  places = [await newProject(f), await newProject(f), await newProject(f)];
  source = {
    stack: f.stack,
    database: f.api.database.database,
    maintenance: f.api.database.pool("maintenance"),
    superuser: f.api.superuser,
  };
  restorer = await pairRestorer(source);
  provisioner = await f.fx.start();
  dispatcher = startOutboxDispatcher(f.api.pool, () => undefined, { intervalMs: 500 });
}, 900_000);

afterAll(async () => {
  await dispatcher?.stop();
  await provisioner?.stop();
  await f.close();
}, 300_000);

/** Shared by the workers: whether reductions may run now, and what went wrong. */
const shared = {
  stop: false,
  reduce: false,
  failures: [] as string[],
  reductions: 0,
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function check(worker: string, status: number, code: string | undefined): void {
  if (status >= 500 && code !== "busy")
    shared.failures.push(`${worker}: ${String(status)} ${code ?? ""}`);
}

async function loop(name: string, body: () => Promise<void>, gapMs = 150): Promise<void> {
  while (!shared.stop) {
    try {
      await body();
    } catch (error) {
      shared.failures.push(
        `${name}: threw ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await pause(gapMs);
  }
}

/** The error code of a refusal, if the body is the envelope. */
async function codeOf(response: Response): Promise<string | undefined> {
  try {
    return ((await response.json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

const name = () => `C_${randomBytes(5).toString("hex").toUpperCase()}`;

function workers(resolveToken: string): Promise<void>[] {
  const mine: string[] = [];
  const credentials: string[] = [];
  const sessions: string[] = [];
  let password = f.tenants.credentials("ungrantedA").password;
  const archived = new Set<string>();
  return [
    // 1. Secret writes and deletes.
    loop("secrets", async () => {
      const key = name();
      const created = await f.create("env1a", key, "synthetic");
      check("secrets", created.status, created.code);
      if (created.status === 201) mine.push(key);
      const target = mine.shift();
      if (target !== undefined && Math.random() < 0.5) {
        const deleted = await f.send("POST", `${f.env("env1a").path}/secrets/${target}/delete`, {
          body: {},
          key: randomUUID(),
        });
        check("secrets", deleted.status, deleted.code);
      } else if (target !== undefined) {
        mine.push(target);
      }
    }),
    // 2. Imports: preview and apply.
    loop(
      "imports",
      async () => {
        const text = `${name()}=synthetic-a\n${name()}=synthetic-b\n`;
        const previewed = await f.send("POST", `${f.env("env1b").path}/import/preview`, {
          text,
          key: null,
        });
        check("imports", previewed.status, previewed.code);
        if (previewed.status !== 200) return;
        const applied = await f.send(
          "POST",
          `${f.env("env1b").path}/import/${previewed.body.previewId as string}/apply`,
          { text },
        );
        check("imports", applied.status, applied.code);
      },
      500,
    ),
    // 3. Issuance, and revocation while reductions run.
    loop(
      "credentials",
      async () => {
        await f.freshen().catch(() => undefined);
        // Freshened above, where a refusal during a capture is expected.
        const issued = await f.issue("env1a", { ttlSeconds: 3600 }, { fresh: false });
        check("credentials", issued.status, issued.code);
        if (issued.status === 201) {
          credentials.push((issued.body.credential as { credentialId: string }).credentialId);
        }
        if (shared.reduce) {
          const target = credentials.shift();
          if (target !== undefined) {
            const revoked = await f.revoke("env1a", target);
            check("credentials", revoked.status, revoked.code);
            if (revoked.status === 200) shared.reductions += 1;
          }
        }
      },
      300,
    ),
    // 4. Archive while reductions run; reactivation otherwise.
    loop(
      "lifecycle",
      async () => {
        const place = places[Math.floor(Math.random() * places.length)]!;
        if (archived.has(place.environmentId)) {
          const back = await reactivate(f, place.path);
          check("lifecycle", back.status, back.code);
          if (back.status === 200) archived.delete(place.environmentId);
        } else if (shared.reduce) {
          const gone = await archive(f, place.path);
          check("lifecycle", gone.status, gone.code);
          if (gone.status === 200) {
            archived.add(place.environmentId);
            shared.reductions += 1;
          }
        }
      },
      700,
    ),
    // 5. Projects and environments through the API: provisioner jobs.
    loop(
      "resources",
      async () => {
        const project = await f.send(
          "POST",
          `/v1/organizations/${f.tenants.a.organizationId}/projects`,
          { body: { name: `p-${randomBytes(4).toString("hex")}` }, key: randomUUID() },
        );
        // A project comes with its development environment: a provisioner job.
        check("resources", project.status, project.code);
      },
      2_000,
    ),
    // 6. Sign-in with TOTP and session activity; sign-out and session
    //    revocation from a stock of sessions while reductions run.
    loop(
      "sessions",
      async () => {
        if (sessions.length < 6) {
          const { email, password: secret, seed } = f.tenants.credentials("editorA");
          const signed = await signInComplete(f.api, { email, password: secret, seed }).catch(
            () => null,
          );
          if (signed !== null) {
            sessions.push(signed.cookie);
            const active = await f.api.request("POST", "/v1/session/activity", {
              body: {},
              cookie: signed.cookie,
            });
            check("sessions", active.status, await codeOf(active));
          }
        }
        if (shared.reduce && sessions.length > 0) {
          const cookie = sessions.shift()!;
          const out = await f.api.request("POST", "/v1/auth/sign-out", { body: {}, cookie });
          check("sessions", out.status, await codeOf(out));
          if (out.status === 200) shared.reductions += 1;
        }
      },
      400,
    ),
    // 7. Password change of a user no other worker signs in as.
    loop(
      "password",
      async () => {
        const { email, seed } = f.tenants.credentials("ungrantedA");
        const signed = await signInComplete(f.api, { email, password, seed }).catch(() => null);
        if (signed === null) return;
        const next = `Synthetic-${randomBytes(12).toString("hex")}`;
        const changed = await f.api.request("POST", "/v1/auth/change-password", {
          body: { currentPassword: password, newPassword: next },
          cookie: signed.cookie,
        });
        check("password", changed.status, await codeOf(changed));
        if (changed.status === 200) password = next;
      },
      13_000,
    ),
    // 8. Machine resolves.
    loop(
      "machine",
      async () => {
        const resolved = await machineCall(f, "resolve", { env: "env1b", token: resolveToken });
        check("machine", resolved.status, resolved.code);
      },
      200,
    ),
  ];
}

/** The machine tokens of an environment in a restored OpenBao, by accessor. */
/**
 * Every token of the restored OpenBao, grouped by policy: listed and looked up
 * once per restore (the workers keep adding tokens and environments, and a
 * lookup per environment and token grew the check past the hour).
 */
async function restoredTokensByPolicy(bao: Stack): Promise<Map<string, string[]>> {
  const admin = new OpenBaoAdmin(bao.bao, bao.bao.rootToken);
  // A restored OpenBao answers its health check before it has loaded its
  // tokens: the first listing can time out. It is asked again for two minutes.
  let accessors: string[] | null = null;
  for (let attempt = 0; accessors === null; attempt += 1) {
    try {
      accessors = await admin.listAccessors(f.fx.namespace);
    } catch (error) {
      if (attempt >= 24) throw error;
      await pause(5_000);
    }
  }
  const byPolicy = new Map<string, string[]>();
  const queue = [...accessors];
  const lookups = Array.from({ length: 16 }, async () => {
    for (let accessor = queue.pop(); accessor !== undefined; accessor = queue.pop()) {
      const lookup = await baoAnswer(bao, bao.bao.rootToken, "POST", "auth/token/lookup-accessor", {
        namespace: f.fx.namespace,
        body: { accessor },
      });
      if (lookup.status !== 200) continue;
      const data = (lookup.body.data ?? {}) as { policies?: string[] };
      for (const policy of data.policies ?? []) {
        byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), accessor]);
      }
    }
  });
  await Promise.all(lookups);
  progress(`  ${String(accessors.length)} tokens in the restored OpenBao`);
  return byPolicy;
}

/** The restored pair agrees with itself (Review focus 1). */
async function expectWhole(pair: TakenPair, restored: RestoredPair): Promise<void> {
  const environments = await restored.db.query<{ id: string }>(
    "SELECT id FROM app.environment WHERE kv_ready AND organization_id = $1",
    [f.tenants.a.organizationId],
  );
  const tokens = await restoredTokensByPolicy(restored.bao);
  for (const { id } of environments.rows) {
    const rows = await restored.db.query<{ accessor: string }>(
      `SELECT accessor FROM app.machine_credential
        WHERE environment_id = $1 AND state = 'active' AND effective_expires_at > now()`,
      [id],
    );
    const catalog = rows.rows.map((row) => row.accessor).sort();
    const backend = [...(tokens.get(machineName(id as EnvironmentId)) ?? [])].sort();
    expect(backend, `pair ${pair.pairId}: tokens of ${id}`).toEqual(catalog);
  }
  const counts = await restored.db.query<{
    executing: number;
    slots: number;
    orphan_sessions: number;
    orphan_accounts: number;
    double_accounts: number;
  }>(
    `SELECT (SELECT count(*)::int FROM app.operation WHERE state = 'executing') AS executing,
            (SELECT count(*)::int FROM app.effect_slot) AS slots,
            (SELECT count(*)::int FROM auth.session s
              WHERE NOT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = s.user_id)) AS orphan_sessions,
            (SELECT count(*)::int FROM auth.account a
              WHERE NOT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = a.user_id)) AS orphan_accounts,
            (SELECT count(*)::int FROM (SELECT user_id, provider_id FROM auth.account
                                         GROUP BY 1, 2 HAVING count(*) > 1) d) AS double_accounts`,
  );
  expect(counts.rows[0], `pair ${pair.pairId}`).toEqual({
    executing: 0,
    slots: 0,
    orphan_sessions: 0,
    orphan_accounts: 0,
    double_accounts: 0,
  });
}

describe("forty captures against everything at once", () => {
  it("every eligible pair restores whole; every crossed pair is ineligible; no 5xx but busy", async () => {
    const resolveToken = (await issueFor(f, "env1b", { ttlSeconds: 7200 })).token;
    const running = workers(resolveToken);
    const outcome = { eligible: 0, crossed: 0, busy: 0, frozen: [] as number[] };
    try {
      for (let index = 0; index < CAPTURES;) {
        shared.reduce = index % 2 === 1;
        await pause(2_000 + Math.random() * 3_000);
        progress(`capture ${String(index)}: taking`);
        const pair = await takePair(source, "compete");
        progress(
          `capture ${String(index)}: ${pair === null ? "busy" : `taken in ${String(pair.frozenMs)} ms frozen`}`,
        );
        if (pair === null) {
          outcome.busy += 1;
          // A drain that never succeeds is a finding, not a reason to wait an hour.
          expect(outcome.busy, "captures answered busy").toBeLessThanOrEqual(CAPTURES / 2);
          continue;
        }
        index += 1;
        outcome.frozen.push(pair.frozenMs);
        try {
          if (await crossedByReduction(source.maintenance, pair.pairId)) {
            expect(await markIneligible(source.maintenance, pair.pairId, "access_reduction")).toBe(
              true,
            );
            outcome.crossed += 1;
            continue;
          }
          expect(
            await markEligible(source.maintenance, pair.pairId, {
              objectKey: `local/${pair.pairId}`,
              manifestSha256: "0".repeat(64),
              artifactHashes: {},
              eligibleUntil: new Date(Date.now() + 30 * 86_400_000),
            }),
          ).toBe(true);
          outcome.eligible += 1;
          progress(`capture ${String(index)}: restoring`);
          const restored = await restorer.restore(pair);
          progress(`capture ${String(index)}: checking`);
          try {
            await expectWhole(pair, restored);
          } finally {
            await restored.drop();
          }
        } finally {
          rmSync(pair.directory, { recursive: true, force: true });
        }
      }
    } finally {
      shared.stop = true;
      progress("stopping the workers");
      await Promise.all(running);
      progress("workers stopped");
    }
    const sorted = [...outcome.frozen].sort((a, b) => a - b);
    console.log(
      `captures ${String(CAPTURES)}: eligible ${String(outcome.eligible)}, crossed ${String(
        outcome.crossed,
      )}, busy ${String(outcome.busy)}; freeze median ${String(
        sorted[Math.floor(sorted.length / 2)],
      )} ms, worst ${String(sorted.at(-1))} ms; reductions ${String(shared.reductions)}`,
    );
    expect(shared.failures).toEqual([]);
    expect(outcome.eligible, "did not exercise: eligible pairs").toBeGreaterThanOrEqual(
      MINIMUM_OF_EACH,
    );
    expect(outcome.crossed, "did not exercise: crossed pairs").toBeGreaterThanOrEqual(
      MINIMUM_OF_EACH,
    );
  }, 3_600_000);
});
