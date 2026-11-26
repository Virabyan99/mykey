// Run 5.1 Task C (P-86, FR-1.41): credentials.list, the inventory. The
// catalog's view, never an accessor or a token; an `active` row past its
// expiry reads `expired` on database time.
import { renderPolicy } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

// Session 11 (D-15's amendment): boundCidrs, issuedByKind and kind are added.
const VIEW_KEYS = [
  "boundCidrs",
  "credentialId",
  "environmentId",
  "expiresAt",
  "expiringSoon",
  "issuedAt",
  "issuedBy",
  "issuedByKind",
  "kind",
  "lastUsedAt",
  "name",
  "projectId",
  "state",
];

type View = Record<string, unknown> & { credentialId: string; state: string };

async function list(
  env: EnvName,
  query = "",
): Promise<{ credentials: View[]; nextCursor: string | null }> {
  const answer = await f.send("GET", `${f.env(env).path}/credentials${query}`, { key: null });
  expect(answer.status, answer.code ?? "").toBe(200);
  return answer.body as unknown as { credentials: View[]; nextCursor: string | null };
}

describe("credentials.list", () => {
  it("the fields of the view, and no others: no accessor, no token", async () => {
    const issued = await issueFor(f, "env1a", { name: "inventory one", ttlSeconds: 3600 });
    const { credentials } = await list("env1a");
    const row = credentials.find((c) => c.credentialId === issued.credentialId);
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(VIEW_KEYS);
    expect(row).toMatchObject({
      name: "inventory one",
      projectId: f.env("env1a").projectId,
      environmentId: f.env("env1a").environmentId,
      state: "active",
      issuedBy: f.tenants.userId("ownerA"),
      lastUsedAt: null,
      // A 30-day token reads as it always was.
      kind: "token",
      issuedByKind: "user",
      boundCidrs: [],
    });
    expect(typeof row!.issuedAt).toBe("string");
    expect(JSON.stringify(credentials).includes(issued.token)).toBe(false);
    await clearCredentials(f, f.env("env1a").environmentId);
  });

  it("expiringSoon: true for a lifetime of one hour, false for 30 days", async () => {
    const soon = await issueFor(f, "env1a", { ttlSeconds: 3600 });
    const later = await issueFor(f, "env1a");
    const { credentials } = await list("env1a");
    expect(credentials.find((c) => c.credentialId === soon.credentialId)?.expiringSoon).toBe(true);
    expect(credentials.find((c) => c.credentialId === later.credentialId)?.expiringSoon).toBe(
      false,
    );
    await clearCredentials(f, f.env("env1a").environmentId);
  });

  it("a token past its expiry reads expired although the stored state is still active", async () => {
    const issued = await issueFor(f, "env1b", { ttlSeconds: 2 });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const past = await f.api.superuser.query<{ past: boolean }>(
        "SELECT effective_expires_at <= now() AS past FROM app.machine_credential WHERE id = $1",
        [issued.credentialId],
      );
      if (past.rows[0]?.past === true || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stored = await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [issued.credentialId],
    );
    expect(stored.rows[0]?.state).toBe("active");
    const { credentials } = await list("env1b");
    expect(credentials.find((c) => c.credentialId === issued.credentialId)?.state).toBe("expired");
    await clearCredentials(f, f.env("env1b").environmentId);
  });

  it("rows of another environment are not listed; a row that was never a token is not listed", async () => {
    const other = await issueFor(f, "env1b", { ttlSeconds: 600 });
    const issuerPolicy = renderPolicy("issuer");
    await f.admin.putPolicy(
      f.fx.namespace,
      "issuer",
      issuerPolicy
        .split("\n")
        .filter((line) => !line.includes("auth/token/create/"))
        .join("\n"),
    );
    let refused;
    try {
      refused = await f.issue("env1a");
    } finally {
      await f.admin.putPolicy(f.fx.namespace, "issuer", issuerPolicy);
    }
    expect(refused.code).toBe("backend_inconsistent");
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
      [f.env("env1a").environmentId],
    );
    const never = await f.api.superuser.query<{ id: string }>(
      "SELECT id FROM app.machine_credential WHERE issuance_operation_id = $1",
      [refused.operationId],
    );
    const { credentials } = await list("env1a");
    const ids = credentials.map((c) => c.credentialId);
    expect(ids).not.toContain(other.credentialId);
    expect(never.rows[0]?.id).toBeDefined();
    expect(ids).not.toContain(never.rows[0]!.id);
    await clearCredentials(f, f.env("env1b").environmentId);
  });

  it("120 credentials page 50/50/20, newest first", async () => {
    const made: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      made.push((await issueFor(f, "env2a", { ttlSeconds: 600 })).credentialId);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const query: string =
        cursor === null ? "?limit=50" : `?limit=50&cursor=${encodeURIComponent(cursor)}`;
      const page = await list("env2a", query);
      sizes.push(page.credentials.length);
      seen.push(...page.credentials.map((c) => c.credentialId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual([...made].reverse());
    await clearCredentials(f, f.env("env2a").environmentId);
  });
});
