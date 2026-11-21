// Run 9.0 Task G (P-160, Review focus 1): the command palette goes anywhere
// and holds nothing secret. Its sources are pages, projects, environments,
// help articles and actions, all named in palette/sources.ts; that file
// names no secret-bearing route and no secret list, and reads nothing but
// the scope the frame already has.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_BEARING, paletteEntries } from "@mykey/web";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../../apps/web/src/palette/sources.ts"),
  "utf8",
);

const ORG = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const PROJECT = "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b";
const ENV = "1d7b6f1c-2a1e-4f43-9a51-9f010b3a3c1e";

const scope = {
  userId: "u",
  organizations: [{ id: ORG, role: "owner", state: "active" }],
  organization: { id: ORG, role: "owner", state: "active" },
  projects: {
    items: [{ id: PROJECT, name: "Shop", state: "active", reviewReason: null }],
    more: false,
  },
  project: { id: PROJECT, name: "Shop", state: "active", reviewReason: null },
  environments: {
    items: [{ id: ENV, name: "dev", state: "active", reviewReason: null }],
    more: false,
  },
  environment: { id: ENV, name: "dev", state: "active", reviewReason: null },
};

describe("the palette's sources", () => {
  it("the palette's sources are pages, projects, environments, help articles and actions; the source file names no secret-bearing route and no secret list", () => {
    const kinds = new Set(paletteEntries(scope).map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual(["action", "environment", "help", "page", "project"]);
    for (const id of SECRET_BEARING)
      expect(SOURCE, id).not.toContain(id.startsWith("/") ? id : `"${id}"`);
    for (const word of [
      "secrets.list",
      "secrets.history",
      "callSecret",
      "useQuery",
      "useInfiniteQuery",
      "call(",
    ]) {
      expect(SOURCE, word).not.toContain(word);
    }
  });

  it("an entry is a place or an action, never a secret's name", () => {
    const entries = paletteEntries(scope);
    expect(entries.find((entry) => entry.label === "Machine credentials")?.to).toBe(
      `/o/${ORG}/p/${PROJECT}/e/${ENV}/credentials`,
    );
    expect(entries.some((entry) => entry.kind === "project" && entry.label === "Shop")).toBe(true);
    expect(entries.every((entry) => entry.to === undefined || entry.to.startsWith("/"))).toBe(true);
  });

  it("without a scope there are only pages, help and actions that need none", () => {
    const kinds = new Set(paletteEntries(null).map((entry) => entry.kind));
    expect(kinds.has("project")).toBe(false);
    expect(kinds.has("environment")).toBe(false);
    expect(kinds.has("help")).toBe(true);
  });
});
