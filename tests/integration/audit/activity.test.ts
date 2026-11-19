// Run 6.1 Task B (P-108, Doc 06 §18.3, AC-1.48): the workspace's timeline.
// The same rows as the audit view, the product's actions only, each item with
// its operation's state now and the current name of what it targets.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVITY_ACTIONS } from "@mykey/audit";
import { createSecretsFixture, type SecretsFixture } from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface Item {
  id: string;
  action: string;
  operationId: string | null;
  target: { kind: string; id: string | null } | null;
  operation: { id: string; state: string; action: string } | null;
  targetName: string | null;
}

const org = (): string => f.tenants.a.organizationId;

async function activity(query: Record<string, string> = {}, user: FixtureUser = "ownerA") {
  const qs = new URLSearchParams(query).toString();
  return f.send("GET", `/v1/organizations/${org()}/activity${qs === "" ? "" : `?${qs}`}`, {
    user,
    key: null,
  });
}

async function allItems(query: Record<string, string> = {}): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 200; pages += 1) {
    const answer = await activity({
      ...query,
      limit: "50",
      ...(cursor === null ? {} : { cursor }),
    });
    expect(answer.status, answer.text).toBe(200);
    items.push(...(answer.body.items as Item[]));
    cursor = answer.body.nextCursor as string | null;
    if (cursor === null) return items;
  }
  throw new Error("the listing did not end");
}

describe("activity.list", () => {
  it("serves only the product's actions, and only to owners and admins", async () => {
    const items = await allItems();
    expect(items.length).toBeGreaterThan(0);
    const allowed = new Set<string>(ACTIVITY_ACTIONS);
    expect(items.filter((item) => !allowed.has(item.action)).map((item) => item.action)).toEqual(
      [],
    );
    expect((await activity({}, "adminA")).status).toBe(200);
    expect((await activity({}, "editorA")).status).toBe(403);
    const foreign = await f.send("GET", `/v1/organizations/${org()}/activity`, {
      user: "ownerB",
      key: null,
    });
    expect(foreign.status).toBe(404);
  });

  it("an item of a secret write carries operation.state succeeded; after the fixture makes an operation uncertain the same item says uncertain", async () => {
    const name = `ACT_${randomBytes(5).toString("hex").toUpperCase()}`;
    const created = await f.create("env1a", name, `${mark}-${randomUUID()}`);
    expect(created.status).toBe(201);
    const operationId = created.operationId ?? "";
    expect(operationId).not.toBe("");
    const find = async (): Promise<Item | undefined> =>
      (await allItems({ environmentId: f.env("env1a").environmentId })).find(
        (item) => item.operationId === operationId && item.action === "secret.create",
      );
    const before = await find();
    expect(before?.operation).toEqual({
      id: operationId,
      state: "succeeded",
      action: "secrets.create",
    });
    await f.api.superuser.query("UPDATE app.operation SET state = 'uncertain' WHERE id = $1", [
      operationId,
    ]);
    try {
      expect((await find())?.operation?.state).toBe("uncertain");
    } finally {
      await f.api.superuser.query("UPDATE app.operation SET state = 'succeeded' WHERE id = $1", [
        operationId,
      ]);
    }
  });

  it("targetName is the current name after a rename", async () => {
    const { projectId } = f.env("env1a");
    const rename = async (name: string) => {
      const answer = await f.send("PATCH", `/v1/organizations/${org()}/projects/${projectId}`, {
        body: { name },
      });
      expect(answer.status, answer.text).toBe(200);
    };
    const first = `act-${randomBytes(3).toString("hex")}`;
    const second = `act-${randomBytes(3).toString("hex")}`;
    await rename(first);
    await rename(second);
    const renames = (await allItems({ projectId })).filter(
      (item) => item.action === "project.rename" && item.target?.id === projectId,
    );
    expect(renames.length).toBeGreaterThanOrEqual(2);
    for (const item of renames) expect(item.targetName).toBe(second);
    // A secret's item targets its environment and carries that environment's name.
    const envItems = await allItems({ environmentId: f.env("env1a").environmentId });
    const names = new Set(envItems.map((item) => item.targetName));
    expect(names.size).toBe(1);
    expect([...names][0]).not.toBeNull();
  });
});
