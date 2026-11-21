// Run 9.7 Task A (Session 8's review R4-2, R4-3, R4-7, R4-10): the parts of
// a host restore that keep root tokens, with no host. Where a new init answer
// goes when the custody copy already holds another (a host restored onto its
// own reinstalled server); which root tokens a restore offers the target's
// OpenBao, in which order; how generate-root's answer becomes a token with
// the source's recovery key; what the custody copy holds after the opening;
// and that a deploy does not open a host whose restore is not finished.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  custodyAfterRestore,
  custodyInitPlan,
  datedCustodyPath,
  decodeGeneratedRoot,
  generateRoot,
  rootTokenCandidates,
  writeCustodyAfterRestore,
} from "../../../scripts/host-restore.ts";
import { custodyCopyPath, deployRestoreRefusal } from "../../../scripts/host.ts";

const answer = (root: string, recovery: string): string =>
  `${JSON.stringify({ root_token: root, recovery_keys_base64: [recovery] }, null, 2)}\n`;

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mykey-custody-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("bao-init's custody copy (R4-10)", () => {
  const at = new Date("2026-12-01T10:20:30.000Z");

  it("a host restored onto its own reinstalled server: the new init answer goes to a dated custody path, and bao-init refuses only the same path", () => {
    const lost = answer("s.lost", "bG9zdA==");
    const fresh = answer("s.fresh", "ZnJlc2g=");
    const dated = datedCustodyPath("prod", at, home);
    expect(dated).toBe(
      join(home, ".mykey", "custody", "prod", "openbao-init.2026-12-01T10-20-30Z.json"),
    );
    // No copy yet: the answer is the copy.
    expect(custodyInitPlan({ current: null, dated: [], answer: fresh, datedPath: dated })).toEqual({
      write: custodyCopyPath("prod", home),
    });
    // The same answer again (bao-init run twice): nothing to write.
    expect(custodyInitPlan({ current: fresh, dated: [], answer: fresh, datedPath: dated })).toEqual(
      {
        write: null,
      },
    );
    // The lost host's answer is the copy: the new one goes beside it, dated; the lost one stays.
    expect(custodyInitPlan({ current: lost, dated: [], answer: fresh, datedPath: dated })).toEqual({
      write: dated,
    });
    // A rerun of bao-init finds its own dated copy: nothing to write.
    expect(
      custodyInitPlan({
        current: lost,
        dated: [{ path: dated, text: fresh }],
        answer: fresh,
        datedPath: dated,
      }),
    ).toEqual({ write: null });
    // The dated path itself holds another answer: refused, with the path named.
    expect(() =>
      custodyInitPlan({
        current: lost,
        dated: [{ path: dated, text: answer("s.other", "b3RoZXI=") }],
        answer: fresh,
        datedPath: dated,
      }),
    ).toThrow(dated);
  });
});

describe("the root tokens a restore offers the target's OpenBao (R4-3, R4-10)", () => {
  it("a restore stopped after its OpenBao step can be run again: the restore's own kept token first, then the init answers newest first, then the custody copy", () => {
    const dir = join(home, ".mykey", "custody", "prod");
    mkdirSync(dir, { recursive: true });
    writeFileSync(custodyCopyPath("prod", home), answer("s.custody", "Y3VzdG9keQ=="));
    writeFileSync(join(dir, "openbao-init.2026-12-01T10-20-30Z.json"), answer("s.older", "b2xk"));
    writeFileSync(join(dir, "openbao-init.2026-12-02T08-00-00Z.json"), answer("s.newer", "bmV3"));
    expect(rootTokenCandidates("prod", home).map((c) => c.token)).toEqual([
      "s.newer",
      "s.older",
      "s.custody",
    ]);
    const secrets = join(home, ".mykey", "secrets", "hosts", "prod");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "restore-root-token"), "s.kept\n");
    expect(rootTokenCandidates("prod", home).map((c) => c.from)).toEqual([
      "restore",
      "init openbao-init.2026-12-02T08-00-00Z.json",
      "init openbao-init.2026-12-01T10-20-30Z.json",
      "custody",
    ]);
  });
});

describe("generate-root with the source's recovery key (R4-2)", () => {
  it("the encoded token is the token XOR the one-time password, base64", () => {
    const token = "synthetic-root-token-old-1";
    const otp = "0123456789abcdefghijklmnop";
    const encoded = Buffer.from(
      Array.from(token, (c, i) => c.charCodeAt(0) ^ otp.charCodeAt(i)),
    ).toString("base64");
    expect(decodeGeneratedRoot(encoded, otp)).toBe(token);
    expect(decodeGeneratedRoot(encoded.replace(/=+$/, ""), otp)).toBe(token);
    expect(() => decodeGeneratedRoot(encoded, otp.slice(1))).toThrow(/length/);
  });

  it("cancels any attempt, starts one, gives the recovery key with its nonce and decodes the answer; the key travels in a body only", async () => {
    const token = "synthetic-root-token-new-1";
    const otp = "zyxwvutsrqponmlkjihgfedcba";
    const encoded = Buffer.from(
      Array.from(token, (c, i) => c.charCodeAt(0) ^ otp.charCodeAt(i)),
    ).toString("base64");
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const http = (method: "POST" | "DELETE", path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "DELETE") return Promise.resolve({ status: 204, body: null });
      if (path === "sys/generate-root-token/attempt") {
        return Promise.resolve({ status: 200, body: { nonce: "n-1", otp, started: true } });
      }
      return Promise.resolve({ status: 200, body: { complete: true, encoded_token: encoded } });
    };
    expect(await generateRoot(http, "cmVjb3Zlcnk=")).toBe(token);
    // OpenBao's authenticated sys/ answers carry the same fields under `data`.
    const wrapped = (method: "POST" | "DELETE", path: string, body?: unknown) =>
      http(method, path, body).then((answer) => ({ ...answer, body: { data: answer.body } }));
    expect(await generateRoot(wrapped, "cmVjb3Zlcnk=")).toBe(token);
    calls.splice(3);
    expect(calls).toEqual([
      { method: "DELETE", path: "sys/generate-root-token/attempt" },
      { method: "POST", path: "sys/generate-root-token/attempt", body: {} },
      {
        method: "POST",
        path: "sys/generate-root-token/update",
        body: { key: "cmVjb3Zlcnk=", nonce: "n-1" },
      },
    ]);
    for (const call of calls) expect(call.path).not.toContain("cmVjb3Zlcnk");
  });

  it("an attempt that does not complete with one key is an error, never a token", async () => {
    const http = (method: "POST" | "DELETE", path: string) =>
      Promise.resolve(
        method === "DELETE"
          ? { status: 204, body: null }
          : path.endsWith("attempt")
            ? { status: 200, body: { nonce: "n", otp: "o".repeat(26), started: true } }
            : { status: 200, body: { complete: false, progress: 1, required: 2 } },
      );
    await expect(generateRoot(http, "a2V5")).rejects.toThrow(/did not complete/);
    const refused = () => Promise.resolve({ status: 400, body: { errors: ["bad key"] } });
    await expect(generateRoot(refused, "a2V5")).rejects.toThrow(/HTTP 400/);
  });

  it("after restore-verify --open the custody copy is the source's answer with the new root token, and the copy it replaces is kept dated", () => {
    const source = answer("s.pair", "c291cmNl");
    expect(JSON.parse(custodyAfterRestore(source, "s.new"))).toEqual({
      root_token: "s.new",
      recovery_keys_base64: ["c291cmNl"],
    });
    const at = new Date("2026-12-03T00:00:00.000Z");
    const dir = join(home, ".mykey", "custody", "drill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(custodyCopyPath("drill", home), answer("s.drill-own", "ZHJpbGw="));
    const written = writeCustodyAfterRestore("drill", source, "s.new", at, home);
    expect(written.replaced).toBe(datedCustodyPath("drill", at, home));
    expect(JSON.parse(readFileSync(custodyCopyPath("drill", home), "utf8"))).toMatchObject({
      root_token: "s.new",
    });
    expect(readFileSync(datedCustodyPath("drill", at, home), "utf8")).toBe(
      answer("s.drill-own", "ZHJpbGw="),
    );
    expect(readdirSync(dir).sort()).toEqual([
      "openbao-init.2026-12-03T00-00-00Z.json",
      "openbao-init.json",
    ]);
  });
});

describe("a deploy and a restore that is not finished (R4-7)", () => {
  it("a deploy refuses to open a host whose restore-state.json is still there; without it nothing is refused", () => {
    expect(deployRestoreRefusal(null)).toBeNull();
    expect(deployRestoreRefusal("")).toBeNull();
    const refusal = deployRestoreRefusal(JSON.stringify({ pairId: "p", step: "start" }));
    expect(refusal).toMatch(/restore of this host is not finished/);
    expect(refusal).toContain("/var/lib/mykey/restore-state.json");
    expect(refusal).toContain("restore-verify --open");
  });
});
