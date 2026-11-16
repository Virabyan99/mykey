import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  LOCK_RULES,
  TOKEN_PLAN,
  bucketResource,
  cloudflare,
  lockRuleLoss,
  s3CredentialsFor,
  sameRules,
  tokenAction,
  tokenPolicies,
  tokensWithoutAttempt,
} from "../../../infra/backup/retention-fixture/provision.ts";
import { loadR2ApiToken } from "../../../infra/backup/retention-fixture/r2.ts";
import {
  fixturePlan,
  lockExpiresAt,
  lockRuleFor,
} from "../../../infra/backup/retention-fixture/upload.ts";

const ACCOUNT = "account-synthetic";

describe("provision plan", () => {
  it("names four buckets and eight tokens, one admin and seven bucket-scoped", () => {
    expect(BUCKETS).toEqual([
      "mykey-prod-pairs",
      "mykey-staging-pairs",
      "mykey-audit-archive",
      "mykey-retention-fixture",
    ]);
    expect(TOKEN_PLAN.map((token) => token.name)).toEqual([
      "mykey-r2-admin",
      "mykey-prod-pairs-upload",
      "mykey-prod-pairs-cleanup",
      "mykey-staging-pairs-upload",
      "mykey-staging-pairs-cleanup",
      "mykey-audit-archive-upload",
      "mykey-fixture-upload",
      "mykey-fixture-cleanup",
    ]);
    const admin = TOKEN_PLAN.filter((token) => token.bucket === undefined);
    expect(admin).toEqual([
      { name: "mykey-r2-admin", permissionGroup: "Workers R2 Storage Write" },
    ]);
    for (const token of TOKEN_PLAN.filter((candidate) => candidate.bucket !== undefined)) {
      expect(token.permissionGroup, token.name).toBe("Workers R2 Storage Bucket Item Write");
      expect(BUCKETS, token.name).toContain(token.bucket);
    }
    expect(TOKEN_PLAN.find((token) => token.name === "mykey-fixture-cleanup")?.bucket).toBe(
      "mykey-retention-fixture",
    );
  });

  it("scopes a bucket token to one bucket and the admin token to the account", () => {
    expect(bucketResource(ACCOUNT, "mykey-prod-pairs")).toBe(
      "com.cloudflare.edge.r2.bucket.account-synthetic_default_mykey-prod-pairs",
    );
    const upload = TOKEN_PLAN.find((token) => token.name === "mykey-prod-pairs-upload")!;
    expect(tokenPolicies(upload, ACCOUNT, "group-item-write")).toEqual([
      {
        effect: "allow",
        resources: {
          "com.cloudflare.edge.r2.bucket.account-synthetic_default_mykey-prod-pairs": "*",
        },
        permission_groups: [{ id: "group-item-write" }],
      },
    ]);
    const admin = TOKEN_PLAN.find((token) => token.name === "mykey-r2-admin")!;
    expect(tokenPolicies(admin, ACCOUNT, "group-storage-write")).toEqual([
      {
        effect: "allow",
        resources: { "com.cloudflare.api.account.account-synthetic": "*" },
        permission_groups: [{ id: "group-storage-write" }],
      },
    ]);
  });

  it("derives S3 credentials the way Cloudflare documents: id, and SHA-256 of the value", () => {
    const value = "synthetic-token-value";
    expect(s3CredentialsFor(ACCOUNT, "token-id-1", value)).toEqual({
      accountId: ACCOUNT,
      accessKeyId: "token-id-1",
      secretAccessKey: createHash("sha256").update(value).digest("hex"),
    });
  });

  it("fixes the lock rules of the plan", () => {
    expect(LOCK_RULES["mykey-prod-pairs"]).toEqual([
      {
        id: "pairs-30d",
        enabled: true,
        prefix: "pairs/",
        condition: { type: "Age", maxAgeSeconds: 2_592_000 },
      },
    ]);
    expect(LOCK_RULES["mykey-retention-fixture"].map((rule) => [rule.id, rule.prefix])).toEqual([
      ["fixture-pairs-4d", "pairs/"],
      ["fixture-probe-10m", "probe/"],
    ]);
    expect(LOCK_RULES["mykey-staging-pairs"]).toEqual([]);
    expect(
      LOCK_RULES["mykey-audit-archive"].map((rule) => [
        rule.id,
        rule.prefix,
        rule.condition.maxAgeSeconds,
      ]),
    ).toEqual([
      ["audit-prod-365d", "prod/", 31_536_000],
      ["audit-staging-30d", "staging/", 2_592_000],
      ["audit-probe-10m", "probe/", 600],
    ]);
  });

  it("compares lock rules by content, not by order or extra fields", () => {
    const wanted = LOCK_RULES["mykey-retention-fixture"];
    const readBack = [...wanted].reverse().map((rule) => ({ ...rule, extra: "ignored" }));
    expect(sameRules(wanted, readBack)).toBe(true);
    expect(
      sameRules(wanted, [
        wanted[0]!,
        { ...wanted[1]!, condition: { type: "Age", maxAgeSeconds: 601 } },
      ]),
    ).toBe(false);
    expect(sameRules(wanted, [wanted[0]!])).toBe(false);
    expect(sameRules(wanted, [{ ...wanted[0]!, enabled: false }, wanted[1]!])).toBe(false);
    expect(sameRules([], [])).toBe(true);
  });
});

describe("loadR2ApiToken", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function homeWith(content: unknown): string {
    const home = mkdtempSync(join(tmpdir(), "mykey-home-"));
    homes.push(home);
    const directory = join(home, ".mykey", "secrets", "r2");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "mykey-r2-admin.json"), JSON.stringify(content));
    return home;
  }

  it("reads the API token from the environment first, then from the credential file", () => {
    const home = homeWith({ accountId: ACCOUNT, apiToken: "synthetic-from-file" });
    expect(loadR2ApiToken("mykey-r2-admin", { env: {}, home })).toBe("synthetic-from-file");
    expect(
      loadR2ApiToken("mykey-r2-admin", {
        env: { MYKEY_R2_ADMIN_API_TOKEN: "synthetic-from-env" },
        home,
      }),
    ).toBe("synthetic-from-env");
  });

  it("names the token and never a value when the API token is missing", () => {
    const home = homeWith({ accountId: ACCOUNT, secretAccessKey: "synthetic-secret" });
    const failure = (() => {
      try {
        loadR2ApiToken("mykey-r2-admin", { env: {}, home });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(failure).toBe("R2 API token for mykey-r2-admin: not in the environment or the file");
    expect(failure).not.toContain("synthetic-secret");
    expect(() => loadR2ApiToken("../escape", { env: {}, home })).toThrow(/not a valid token name/);
  });
});

describe("fixture plan", () => {
  const now = new Date("2026-11-11T10:00:00.000Z");

  it("staggers the capture times of the three pairs and names two probes and two controls", () => {
    const plan = fixturePlan(now);
    expect(plan.pairs).toEqual([
      { pairId: "pair-20261111-1", prefix: "pairs/", captureTime: "2026-11-11T08:00:00.000Z" },
      { pairId: "pair-20261111-2", prefix: "pairs/", captureTime: "2026-11-11T09:00:00.000Z" },
      { pairId: "pair-20261111-3", prefix: "pairs/", captureTime: "2026-11-11T10:00:00.000Z" },
      { pairId: "probe-20261111-1", prefix: "probe/", captureTime: "2026-11-11T09:30:00.000Z" },
      { pairId: "probe-20261111-2", prefix: "probe/", captureTime: "2026-11-11T10:00:00.000Z" },
    ]);
    expect(plan.controls).toEqual(["scratch/control-1.txt", "scratch/control-2.txt"]);
  });

  it("finds the lock rule of a key by prefix, and none for scratch", () => {
    const rules = LOCK_RULES["mykey-retention-fixture"];
    expect(lockRuleFor("pairs/pair-20261111-1/bundle.tar", rules)?.id).toBe("fixture-pairs-4d");
    expect(lockRuleFor("probe/probe-20261111-1/manifest.json", rules)?.id).toBe(
      "fixture-probe-10m",
    );
    expect(lockRuleFor("scratch/control-1.txt", rules)).toBeUndefined();
    expect(lockRuleFor("pairs/x", [{ ...rules[0]!, enabled: false }])).toBeUndefined();
  });

  it("computes the lock expiry from the upload time R2 reports", () => {
    expect(lockExpiresAt("2026-11-11T10:00:05.000Z", 600)).toBe("2026-11-11T10:10:05.000Z");
    expect(lockExpiresAt("2026-11-11T10:00:05.000Z", 345_600)).toBe("2026-11-15T10:00:05.000Z");
  });
});

describe("provision review fixes", () => {
  it("never puts a malformed token into an error message", async () => {
    // A bootstrap file with two lines: the header value would be invalid, and the
    // runtime's own error quotes the whole value.
    const twoLines = "synthetic-first-line\nsynthetic-second-line";
    const failure = await cloudflare(twoLines, "GET", "/user/tokens/verify").then(
      () => "no error",
      (error: unknown) => (error as Error).message,
    );
    expect(failure).toBe("Cloudflare API: the token is not one line of token characters");
    expect(failure).not.toContain("synthetic-first-line");
    await expect(cloudflare("", "GET", "/user/tokens/verify")).rejects.toThrow(/not one line/);
  });

  it("refuses to replace lock rules that are stricter than, or missing from, the plan", () => {
    const wanted = LOCK_RULES["mykey-prod-pairs"];
    const live = (maxAgeSeconds: number, id = "pairs-30d") => ({
      id,
      enabled: true,
      prefix: "pairs/",
      condition: { type: "Age" as const, maxAgeSeconds },
    });
    // Nothing live, a shorter live rule, or a disabled live rule: the plan may be applied.
    expect(lockRuleLoss(wanted, [])).toBeUndefined();
    expect(lockRuleLoss(wanted, [live(600)])).toBeUndefined();
    expect(lockRuleLoss(wanted, [{ ...live(9_999_999), enabled: false }])).toBeUndefined();
    // A longer live rule, a live rule the plan does not know, a moved prefix: refused.
    expect(lockRuleLoss(wanted, [live(5_184_000)])).toMatch(/pairs-30d.*shorten/);
    expect(lockRuleLoss(wanted, [live(2_592_000), live(600, "added-by-hand")])).toMatch(
      /added-by-hand.*not in the plan/,
    );
    expect(lockRuleLoss(wanted, [{ ...live(2_592_000), prefix: "other/" }])).toMatch(
      /pairs-30d.*prefix/,
    );
    // A bucket the plan gives no rule must not lose one set elsewhere.
    expect(lockRuleLoss(LOCK_RULES["mykey-staging-pairs"], [live(86_400, "staging-1d")])).toMatch(
      /staging-1d.*not in the plan/,
    );
  });

  it("rolls a token only when asked by name", () => {
    const name = "mykey-prod-pairs-upload";
    expect(tokenAction({ name, exists: false, fileComplete: false, roll: [] })).toBe("create");
    expect(tokenAction({ name, exists: true, fileComplete: true, roll: [] })).toBe("keep");
    // The credential file moved to a server: the token is left alone, not rolled.
    expect(tokenAction({ name, exists: true, fileComplete: false, roll: [] })).toBe("leave");
    expect(tokenAction({ name, exists: true, fileComplete: false, roll: ["other"] })).toBe("leave");
    expect(tokenAction({ name, exists: true, fileComplete: false, roll: [name] })).toBe("roll");
    expect(tokenAction({ name, exists: true, fileComplete: true, roll: [name] })).toBe("roll");
  });

  it("names every object token that has no recorded lock-change attempt", () => {
    const attempt = (token: string) => ({
      token,
      bucket: "mykey-prod-pairs",
      verifiedActive: true,
      status: 403,
      code: 10000,
      denied: true,
      deniedAt: "2026-11-11T10:41:01.000Z",
    });
    expect(tokensWithoutAttempt([])).toHaveLength(7);
    expect(tokensWithoutAttempt([])).not.toContain("mykey-r2-admin");
    const all = TOKEN_PLAN.filter((token) => token.bucket !== undefined).map((token) =>
      attempt(token.name),
    );
    expect(tokensWithoutAttempt(all)).toEqual([]);
    expect(tokensWithoutAttempt(all.slice(1))).toEqual(["mykey-prod-pairs-upload"]);
  });
});
