import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteOutcomes, loadR2Credentials } from "../../../infra/backup/retention-fixture/r2.ts";
import {
  REQUIRED_CLOUD_TOKENS,
  missingCloudCredentials,
} from "../../../scripts/require-cloud-env.ts";

const homes: string[] = [];

/** A temporary home directory holding synthetic credential files for the given tokens. */
function homeWith(tokens: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "mykey-home-"));
  homes.push(home);
  const directory = join(home, ".mykey", "secrets", "r2");
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(tokens)) {
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(content));
  }
  return home;
}

const synthetic = (label: string) => ({
  accountId: "account-synthetic",
  accessKeyId: `id-${label}`,
  secretAccessKey: `secret-${label}`,
});

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("deleteOutcomes", () => {
  it("never reports success from the HTTP status alone", () => {
    // A recorded DeleteObjects answer: HTTP 200, one object deleted, one refused.
    const recorded = {
      $metadata: { httpStatusCode: 200 },
      Deleted: [{ Key: "scratch/control-1" }],
      Errors: [
        {
          Key: "pairs/p1/bundle.tar",
          Code: "ObjectLockedByBucketPolicy",
          Message: "The object is locked by the bucket policy.",
        },
      ],
    };
    expect(deleteOutcomes(["pairs/p1/bundle.tar", "scratch/control-1"], recorded)).toEqual([
      { key: "pairs/p1/bundle.tar", deleted: false, errorCode: "ObjectLockedByBucketPolicy" },
      { key: "scratch/control-1", deleted: true },
    ]);
  });

  it("treats a key the answer does not mention as not deleted", () => {
    expect(deleteOutcomes(["a", "b"], { Deleted: [{ Key: "a" }] })).toEqual([
      { key: "a", deleted: true },
      { key: "b", deleted: false, errorCode: "NotReported" },
    ]);
    expect(deleteOutcomes(["a"], {})).toEqual([
      { key: "a", deleted: false, errorCode: "NotReported" },
    ]);
  });

  it("lets an error win when a key is listed as both deleted and failed", () => {
    expect(
      deleteOutcomes(["a"], {
        Deleted: [{ Key: "a" }],
        Errors: [{ Key: "a", Code: "AccessDenied" }],
      }),
    ).toEqual([{ key: "a", deleted: false, errorCode: "AccessDenied" }]);
    expect(deleteOutcomes(["a"], { Errors: [{ Key: "a" }] })).toEqual([
      { key: "a", deleted: false, errorCode: "Unknown" },
    ]);
  });
});

describe("loadR2Credentials", () => {
  it("reads the token's file under ~/.mykey/secrets/r2", () => {
    const home = homeWith({ "mykey-fixture-upload": synthetic("file") });
    expect(loadR2Credentials("mykey-fixture-upload", { env: {}, home })).toEqual(synthetic("file"));
  });

  it("prefers the environment over the file", () => {
    const home = homeWith({ "mykey-fixture-upload": synthetic("file") });
    const env = {
      MYKEY_R2_ACCOUNT_ID: "account-env",
      MYKEY_FIXTURE_UPLOAD_ACCESS_KEY_ID: "id-env",
      MYKEY_FIXTURE_UPLOAD_SECRET_ACCESS_KEY: "secret-env",
    };
    expect(loadR2Credentials("mykey-fixture-upload", { env, home })).toEqual({
      accountId: "account-env",
      accessKeyId: "id-env",
      secretAccessKey: "secret-env",
    });
  });

  it("fails by token name, without printing any value, when nothing or half is there", () => {
    const empty = homeWith({});
    expect(() => loadR2Credentials("mykey-fixture-upload", { env: {}, home: empty })).toThrow(
      /mykey-fixture-upload/,
    );
    const half = homeWith({ "mykey-fixture-upload": { accountId: "a", accessKeyId: "leak-me" } });
    const failure = (() => {
      try {
        loadR2Credentials("mykey-fixture-upload", { env: {}, home: half });
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(failure).toMatch(/mykey-fixture-upload/);
    expect(failure).not.toContain("leak-me");
    expect(() => loadR2Credentials("../escape", { env: {}, home: empty })).toThrow(/token name/);
  });
});

describe("cloud credential guard", () => {
  it("names every missing token, so cloud tests cannot be skipped silently", () => {
    expect(REQUIRED_CLOUD_TOKENS).toEqual([
      "mykey-fixture-upload",
      "mykey-fixture-cleanup",
      "mykey-r2-admin",
    ]);
    expect(missingCloudCredentials({ env: {}, home: homeWith({}) })).toEqual(REQUIRED_CLOUD_TOKENS);
    const partial = homeWith({ "mykey-fixture-upload": synthetic("u") });
    expect(missingCloudCredentials({ env: {}, home: partial })).toEqual([
      "mykey-fixture-cleanup",
      "mykey-r2-admin",
    ]);
    const complete = homeWith({
      "mykey-fixture-upload": synthetic("u"),
      "mykey-fixture-cleanup": synthetic("c"),
      "mykey-r2-admin": synthetic("a"),
    });
    expect(missingCloudCredentials({ env: {}, home: complete })).toEqual([]);
  });
});
