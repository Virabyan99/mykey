// secrets.list (Run 4.3 Task A, FR-1.21, P-73): pages of the index under a
// signed cursor; never a value, never a call to OpenBao, no lock. Cases that
// never touch the backend seed index rows and remove them afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface Item {
  name: string;
  version: number | null;
  stateTag: string;
  state: string;
  changedAt: string;
}

const tag = (): string => randomBytes(3).toString("hex").toUpperCase();

function list(
  env: EnvName,
  query: Record<string, string> = {},
  user: FixtureUser = "ownerA",
): Promise<Answer> {
  const search = new URLSearchParams(query).toString();
  return f.send("GET", `${f.env(env).path}/secrets${search === "" ? "" : `?${search}`}`, {
    user,
    key: null,
  });
}

const itemsOf = (answer: Answer): Item[] => answer.body.secrets as Item[];

/** Seeds `names`, runs `fn`, removes them. */
async function withSeeded(env: EnvName, names: string[], fn: () => Promise<void>): Promise<void> {
  await f.seedIndex(env, names);
  try {
    await fn();
  } finally {
    await f.unseedIndex(env, names);
  }
}

describe("secrets.list", () => {
  it("an empty environment answers no secrets and no cursor", async () => {
    const answer = await list("env1b");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ secrets: [], nextCursor: null });
  });

  it("120 names page 50, 50, 20: disjoint and complete", async () => {
    const prefix = `P${tag()}_`;
    const names = Array.from({ length: 120 }, (_v, i) => `${prefix}${String(i).padStart(3, "0")}`);
    await withSeeded("env1b", names, async () => {
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const answer = await list("env1b", {
          prefix,
          ...(cursor === null ? {} : { cursor }),
        });
        expect(answer.status).toBe(200);
        sizes.push(itemsOf(answer).length);
        seen.push(...itemsOf(answer).map((item) => item.name));
        cursor = answer.body.nextCursor as string | null;
      } while (cursor !== null);
      expect(sizes).toEqual([50, 50, 20]);
      expect(seen).toEqual(names);
    });
  });

  it("the order is bytewise: A1, AB, A_B", async () => {
    const p = `O${tag()}`;
    const names = [`${p}A_B`, `${p}AB`, `${p}A1`];
    await withSeeded("env1b", names, async () => {
      const answer = await list("env1b", { prefix: p });
      expect(itemsOf(answer).map((item) => item.name)).toEqual([`${p}A1`, `${p}AB`, `${p}A_B`]);
    });
  });

  it("prefixes are literal: DB_ is not DBX, DB is both, A_ does not match AB", async () => {
    const p = `Q${tag()}`;
    const names = [`${p}DB_HOST`, `${p}DBX`, `${p}AB`];
    await withSeeded("env1b", names, async () => {
      const names1 = itemsOf(await list("env1b", { prefix: `${p}DB_` })).map((i) => i.name);
      expect(names1).toEqual([`${p}DB_HOST`]);
      const names2 = itemsOf(await list("env1b", { prefix: `${p}DB` })).map((i) => i.name);
      expect(names2).toEqual([`${p}DBX`, `${p}DB_HOST`]);
      const names3 = itemsOf(await list("env1b", { prefix: `${p}A_` })).map((i) => i.name);
      expect(names3).toEqual([]);
    });
  });

  it("prefix db, D%, an empty prefix are 422", async () => {
    for (const prefix of ["db", "D%", ""]) {
      const answer = await list("env1b", { prefix });
      expect(answer.status, JSON.stringify(prefix)).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
  });

  it("deleted and needs_review names are listed with their state; an item has exactly its five keys", async () => {
    const p = `S${tag()}`;
    await f.seedIndex("env1b", [`${p}D`], "deleted");
    await f.seedIndex("env1b", [`${p}R`], "needs_review");
    await f.seedIndex("env1b", [`${p}L`], "live");
    try {
      const items = itemsOf(await list("env1b", { prefix: p }));
      expect(items.map((i) => [i.name, i.state])).toEqual([
        [`${p}D`, "deleted"],
        [`${p}L`, "live"],
        [`${p}R`, "needs_review"],
      ]);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(
          ["changedAt", "name", "stateTag", "state", "version"].sort(),
        );
      }
    } finally {
      await f.unseedIndex("env1b", [`${p}D`, `${p}R`, `${p}L`]);
    }
  });

  it("a write between two pages is 409 listing_changed; the first page again works", async () => {
    const p = `W${tag()}`;
    const names = Array.from({ length: 3 }, (_v, i) => `${p}_${String(i)}`);
    for (const name of names) {
      expect((await f.create("env1a", name, `synthetic-${randomUUID()}`)).status).toBe(201);
    }
    const first = await list("env1a", { prefix: p, limit: "2" });
    const cursor = first.body.nextCursor as string;
    expect(typeof cursor).toBe("string");
    expect((await f.create("env1a", `${p}_X`, `synthetic-${randomUUID()}`)).status).toBe(201);
    const second = await list("env1a", { prefix: p, limit: "2", cursor });
    expect(second.status).toBe(409);
    expect(second.code).toBe("listing_changed");
    const again = await list("env1a", { prefix: p, limit: "2" });
    expect(again.status).toBe(200);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a cursor of another prefix, another environment or another route is 400", async () => {
    const p = `C${tag()}`;
    const names = [`${p}A`, `${p}B`, `${p}C`];
    await f.seedIndex("env1b", names);
    await f.seedIndex("env2a", names);
    try {
      const first = await list("env1b", { prefix: p, limit: "1" });
      const cursor = first.body.nextCursor as string;
      const otherPrefix = await list("env1b", { prefix: `${p}B`, limit: "1", cursor });
      expect(otherPrefix.status).toBe(400);
      expect(otherPrefix.code).toBe("malformed_request");
      const otherEnvironment = await list("env2a", { prefix: p, limit: "1", cursor });
      expect(otherEnvironment.status).toBe(400);
      const operations = await f.send(
        "GET",
        `${f.env("env1b").path}/operations?cursor=${encodeURIComponent(cursor)}`,
        { key: null },
      );
      expect(operations.status).toBe(400);
      expect(operations.code).toBe("malformed_request");
    } finally {
      await f.unseedIndex("env1b", names);
      await f.unseedIndex("env2a", names);
    }
  });

  it("answers while OpenBao is unreachable", async () => {
    const p = `B${tag()}`;
    await withSeeded("env1b", [`${p}A`], async () => {
      f.setBao("closed");
      try {
        const answer = await list("env1b", { prefix: p });
        expect(answer.status).toBe(200);
        expect(itemsOf(answer)).toHaveLength(1);
      } finally {
        f.setBao("relay");
      }
    });
  });

  it("roles: a reader lists; an ungranted member and another organization's owner get 404", async () => {
    expect((await list("env1a", {}, "readerA")).status).toBe(200);
    expect((await list("env1a", {}, "ungrantedA")).status).toBe(404);
    expect((await list("env1a", {}, "ownerB")).status).toBe(404);
  });

  it("an environment in review is 503", async () => {
    const id = f.env("env1b").environmentId;
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [id],
    );
    try {
      const answer = await list("env1b");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_inconsistent");
    } finally {
      await f.api.superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [id],
      );
    }
    expect((await list("env1b")).status).toBe(200);
  });
});
