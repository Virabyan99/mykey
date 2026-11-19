// Run 6.7 Task B (P-124): a "lost world" and its pair. Organization A of the
// secrets fixture (two projects) gets credentials in every state, sessions in
// two phases, a used and an unused reset link, a verification row and an
// operation left executing; then a pair is captured; each restore puts both
// halves into scratch instances (a new database on the stack's PostgreSQL,
// the scratch OpenBao of scratch-bao.override.yml). The old world's tokens
// are kept in memory to be presented later, never printed.
import { randomBytes, randomUUID } from "node:crypto";
import { createThrottle } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { expect } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "./credentials-fixture.ts";
import {
  pairRestorer,
  takePair,
  type PairRestorer,
  type PairSource,
  type RestoredPair,
  type TakenPair,
} from "./pair-fixture.ts";
import { provisionTestOrganization } from "./org-fixture.ts";
import { baoFetch } from "./stack.ts";

export interface OldWorld {
  /** Machine tokens issued before the capture, by the state their row was left in. */
  tokens: { credentialId: string; token: string; state: string }[];
  /** Reset tokens (the fragment's value) of two accounts. */
  resetTokens: { used: string; unused: string };
  /** The stack's root token: the lost host's. */
  rootToken: string;
  /** A secret of the capture: its name and value (env1a). */
  secret: { name: string; value: string };
  /** The AppRole credentials the lost host's processes held. */
  approles: CredentialsFixture["fx"]["credentials"];
}

export interface LostWorld {
  f: CredentialsFixture;
  pair: TakenPair;
  old: OldWorld;
  /**
   * Both halves into scratch instances; each call replaces the scratch
   * OpenBao. `token` is the restore's own root token, minted by the lost
   * host's: an invalidation leaves it, and the next restore authenticates with it.
   */
  restore(): Promise<RestoredPair & { token: string }>;
  close(): Promise<void>;
}

export async function createLostWorld(): Promise<LostWorld> {
  const f = await createCredentialsFixture({
    stackOverrides: ["scratch-bao.override.yml", "scratch-pg.override.yml"],
  });
  try {
    // Credentials: two per environment, then left in every state the table knows.
    const states = ["active", "revoked", "needs_review", "revoking", "issuing", "expired"];
    const envs = ["env1a", "env1a", "env1b", "env1b", "env2a", "env2a"] as const;
    const tokens: OldWorld["tokens"] = [];
    // All issued first: a row left issuing or needs_review blocks the next issuance.
    for (const [i, env] of envs.entries()) {
      const issued = await issueFor(f, env, { name: `lost-${String(i)}` });
      tokens.push({ ...issued, state: states[i] ?? "active" });
    }
    for (const [i, env] of envs.entries()) {
      const { credentialId, state } = tokens[i] ?? { credentialId: "", state: "active" };
      if (state === "revoked") {
        expect((await f.revoke(env, credentialId)).status).toBe(200);
      } else if (state !== "active") {
        // Left mid-way: the row says so, the token still exists in OpenBao.
        await f.api.superuser.query("UPDATE app.machine_credential SET state = $2 WHERE id = $1", [
          credentialId,
          state,
        ]);
      }
    }

    // Organization B is a row of the tenants only: provisioned here, so the
    // restored world's catalog matches OpenBao for every organization.
    await provisionTestOrganization(f.api, f.stack, f.tenants.b.organizationId);

    // A secret of the capture (its value assembled at run time, never printed).
    const secretValue = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join(
      "_",
    );
    expect((await f.create("env1a", "LOST_WORLD_SECRET", secretValue)).status).toBe(201);

    // Reset links: one used, one unused (each puts its account in recovery_pending).
    const maintenance = f.api.database.pool("maintenance");
    const reset = async (user: "envEditorA" | "ungrantedA"): Promise<string> => {
      const answer = await initiateReset(
        {
          pool: maintenance,
          keys: f.api.keys,
          throttle: createThrottle({ pool: f.api.pool, ring: f.api.keys.rateLimit }),
        },
        { email: f.tenants.credentials(user).email, kind: "password" },
      );
      if (answer.outcome !== "issued") throw new Error(`reset for ${user}: ${answer.outcome}`);
      return answer.token;
    };
    const used = await reset("envEditorA");
    await f.api.superuser.query(
      "UPDATE auth.reset_token SET consumed_at = now() WHERE user_id = $1",
      [f.tenants.userId("envEditorA")],
    );
    const unused = await reset("ungrantedA");

    // Sessions: complete ones (owner, admin) and one that passed the password only.
    await f.tenants.cookie("ownerA");
    await f.tenants.cookie("adminA");
    const reader = f.tenants.credentials("readerA");
    const partial = await f.api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: reader.email, password: reader.password },
    });
    expect(partial.status).toBe(200);
    await f.api.superuser.query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at)
       VALUES ($1, 'lost-world', 'lost-world', now() + interval '1 hour')`,
      [randomUUID()],
    );
    // An operation not finished when the host was lost (accepted: a pair never holds
    // an executing one, the capture drains them first, P-118).
    const { organizationId } = f.tenants.a;
    const lostOperation = randomUUID();
    await f.api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1, $2, 'system', 'test', 'environment.provision', $3, $4, 'accepted')`,
      [lostOperation, organizationId, f.tenants.a.env1a, lostOperation],
    );

    const source: PairSource = {
      stack: f.stack,
      database: f.api.database.database,
      maintenance,
      superuser: f.api.superuser,
    };
    const restorer: PairRestorer = await pairRestorer(source);
    const pair = await takePair(source, "restore-fixture");
    if (pair === null) throw new Error("the capture answered busy");
    const restored: RestoredPair[] = [];
    return {
      f,
      pair,
      old: {
        tokens,
        resetTokens: { used, unused },
        rootToken: f.stack.bao.rootToken,
        secret: { name: "LOST_WORLD_SECRET", value: secretValue },
        approles: f.fx.credentials,
      },
      async restore() {
        const one = await restorer.restore(pair);
        restored.push(one);
        // The first authenticated request after a snapshot restore takes ~5.6 s
        // (the token store loads); the product's clients give a call 5 s.
        const warm = await baoFetch(one.bao, "/v1/auth/token/lookup-self", {
          token: f.stack.bao.rootToken,
        });
        if (warm.status !== 200) throw new Error(`restored OpenBao: HTTP ${String(warm.status)}`);
        const minted = await new OpenBaoAdmin(one.bao.bao, f.stack.bao.rootToken).createRootToken();
        // The scratch's next restore (snapshot-force) authenticates with this one.
        (one.bao.bao as { rootToken: string }).rootToken = minted.token;
        return { ...one, token: minted.token };
      },
      async close() {
        for (const one of restored) await one.drop();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
