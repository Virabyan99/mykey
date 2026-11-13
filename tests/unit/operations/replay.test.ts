// Run 3.9 Task A (P-58, Doc 06 §6.2): the intent fingerprint of a mutation —
// HMAC-SHA-256 under the replay-fingerprint ring over the canonical JSON of
// who asked what on which target with which body (sorted keys, NFC strings).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { intentFingerprint, operationResponse, replayAnswer } from "@mykey/operations";
import { ROUTES, type OperationId } from "@mykey/contracts";
import type { OperationRow } from "@mykey/db";

const ring = {
  current: "k2",
  keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
};
const intent = {
  principalKind: "user",
  principalId: "11111111-1111-4111-8111-111111111111",
  action: "projects.create",
  target: "22222222-2222-4222-8222-222222222222",
  body: { name: "Payments" },
};

describe("intentFingerprint", () => {
  it("is 32 bytes and carries the current key id", () => {
    const { digest, keyId } = intentFingerprint(ring, intent);
    expect(digest).toHaveLength(32);
    expect(keyId).toBe("k2");
  });

  it("a fixed vector: the canonical text, written out by hand", () => {
    const text =
      '{"action":"projects.create","body":{"name":"Payments"},"principalId":"11111111-1111-4111-8111-111111111111","principalKind":"user","target":"22222222-2222-4222-8222-222222222222"}';
    const expected = createHmac("sha256", Buffer.from(ring.keys.k2)).update(text).digest();
    expect(intentFingerprint(ring, intent).digest.equals(expected)).toBe(true);
  });

  it("is equal for bodies that differ only in key order, and for the NFC form of a string", () => {
    const a = intentFingerprint(ring, { ...intent, body: { a: 1, b: { x: "é", y: 2 } } });
    const b = intentFingerprint(ring, { ...intent, body: { b: { y: 2, x: "é" }, a: 1 } });
    expect(a.digest.equals(b.digest)).toBe(true);
  });

  it("differs for another name, principal, action or target", () => {
    const base = intentFingerprint(ring, intent).digest;
    for (const changed of [
      { ...intent, body: { name: "payments" } },
      { ...intent, principalId: "33333333-3333-4333-8333-333333333333" },
      { ...intent, principalKind: "machine" },
      { ...intent, action: "projects.rename" },
      { ...intent, target: "44444444-4444-4444-8444-444444444444" },
    ]) {
      expect(intentFingerprint(ring, changed).digest.equals(base)).toBe(false);
    }
  });

  it("under a named older key it is that key's digest", () => {
    const old = intentFingerprint(ring, intent, "k1");
    expect(old.keyId).toBe("k1");
    expect(old.digest.equals(intentFingerprint(ring, intent).digest)).toBe(false);
  });
});

// Run 4.1 Task B (P-64): the path parameters other than org/project/env.
describe("intentFingerprint with params", () => {
  it("an intent without params keeps the fixed vector of Run 3.9", () => {
    const text =
      '{"action":"projects.create","body":{"name":"Payments"},"principalId":"11111111-1111-4111-8111-111111111111","principalKind":"user","target":"22222222-2222-4222-8222-222222222222"}';
    const expected = createHmac("sha256", Buffer.from(ring.keys.k2)).update(text).digest();
    expect(intentFingerprint(ring, { ...intent, params: {} }).digest.equals(expected)).toBe(true);
  });

  it("params A differ from params B and from none", () => {
    const a = intentFingerprint(ring, { ...intent, params: { name: "A" } }).digest;
    const b = intentFingerprint(ring, { ...intent, params: { name: "B" } }).digest;
    const none = intentFingerprint(ring, intent).digest;
    expect(a.equals(b)).toBe(false);
    expect(a.equals(none)).toBe(false);
    expect(intentFingerprint(ring, { ...intent, params: { name: "A" } }).digest.equals(a)).toBe(
      true,
    );
  });
});

// Run 4.1 Task B (P-65): the stored state decides the replayed answer.
describe("replayAnswer", () => {
  const created = ROUTES.find((route) => route.id === "projects.create")!;
  const renamed = ROUTES.find((route) => route.id === "projects.rename")!;
  const row = (overrides: Partial<OperationRow>): OperationRow => ({
    id: "55555555-5555-4555-8555-555555555555" as OperationId,
    organizationId: null,
    projectId: null,
    environmentId: null,
    secretName: null,
    parentOperationId: null,
    principalKind: "user",
    principalId: intent.principalId,
    action: "projects.create",
    target: intent.target,
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
    state: "succeeded",
    fingerprint: null,
    fingerprintKeyId: null,
    expected: null,
    executorBootId: null,
    dispatchedAt: null,
    heartbeatAt: null,
    result: { projectId: "p" },
    errorCode: null,
    createdAt: new Date(),
    completedAt: new Date(),
    replayExpiresAt: new Date(Date.now() + 86_400_000),
    expired: false,
    ...overrides,
  });

  it.each(["accepted", "executing", "awaiting_input"] as const)(
    "%s → 202 with the envelope",
    (state) => {
      const answer = replayAnswer(created, row({ state, result: null, replayExpiresAt: null }));
      expect(answer).toMatchObject({ status: 202, body: { state, operationId: row({}).id } });
    },
  );

  it("succeeded → the route's completed status (201 or 200) with the result", () => {
    expect(replayAnswer(created, row({}))).toMatchObject({
      status: 201,
      body: { result: { projectId: "p" } },
    });
    expect(replayAnswer(renamed, row({}))).toMatchObject({ status: 200 });
  });

  it("partial → 200", () => {
    expect(replayAnswer(created, row({ state: "partial" }))).toMatchObject({ status: 200 });
  });

  it("rejected → the stored error with the operation id", () => {
    expect(
      replayAnswer(created, row({ state: "rejected", result: null, errorCode: "busy" })),
    ).toEqual({
      error: "busy",
      operationId: row({}).id,
    });
  });

  it("uncertain → outcome_unknown with the operation id", () => {
    expect(
      replayAnswer(created, row({ state: "uncertain", result: null, replayExpiresAt: null })),
    ).toEqual({ error: "outcome_unknown", operationId: row({}).id });
  });

  it("a terminal row past its expiry → replay_expired", () => {
    for (const state of ["succeeded", "partial", "rejected"] as const) {
      expect(replayAnswer(created, row({ state, expired: true }))).toMatchObject({
        error: "replay_expired",
      });
    }
  });

  it("the envelope of a rejected row carries its error code; an uncertain one no result", () => {
    expect(
      operationResponse(row({ state: "rejected", result: null, errorCode: "busy" })).result,
    ).toEqual({
      errorCode: "busy",
    });
    expect(operationResponse(row({ state: "uncertain", result: null })).result).toBeUndefined();
  });
});
