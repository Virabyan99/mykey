// Run 6.3 Task C (P-115, FR-1.61, AC-1.24): the capacity record the host
// writes and the API reads per mutation. `capacityState` holds the thresholds;
// `readCapacity` turns a file into ok, low or unknown with its cause.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPANDING_ROUTES,
  LIMITS,
  REDUCING_ROUTES,
  ROUTES,
  capacityState,
  type CapacityRecord,
} from "@mykey/contracts";
import { readCapacity } from "@mykey/operations";
import { afterAll, describe, expect, it } from "vitest";

const GiB = 2 ** 30;
const RESERVE = LIMITS.disk.minFreeBytes + LIMITS.disk.auditReserveBytes;
const volume = (freeBytes: number, sizeBytes: number, freeInodesPercent = 50) => ({
  freeBytes,
  sizeBytes,
  freeInodesPercent,
});
const only = (v: ReturnType<typeof volume>): CapacityRecord["volumes"] => ({
  postgres: volume(500 * GiB, 1000 * GiB),
  openbao: volume(500 * GiB, 1000 * GiB),
  "bao-audit": volume(500 * GiB, 1000 * GiB),
  docker: v,
});

describe("capacityState (P-115)", () => {
  it("free bytes under 15 % of the size: one byte either side", () => {
    const size = 100 * GiB;
    const line = (size * LIMITS.disk.minFreeBytesPercent) / 100;
    expect(capacityState(only(volume(line, size)))).toBe("ok");
    expect(capacityState(only(volume(line - 1, size)))).toBe("low");
  });

  it("free bytes under minFreeBytes + auditReserveBytes (4 GiB): one byte either side", () => {
    const size = 20 * GiB; // 15 % is 3 GiB: only the absolute line applies
    expect(capacityState(only(volume(RESERVE, size)))).toBe("ok");
    expect(capacityState(only(volume(RESERVE - 1, size)))).toBe("low");
  });

  it("free inodes under 10 %", () => {
    expect(capacityState(only(volume(500 * GiB, 1000 * GiB, 10)))).toBe("ok");
    expect(capacityState(only(volume(500 * GiB, 1000 * GiB, 9.99)))).toBe("low");
  });

  it("no volumes is not ok", () => {
    expect(capacityState({})).toBe("low");
  });
});

describe("readCapacity (P-115)", () => {
  const directory = mkdtempSync(join(tmpdir(), "mykey-capacity-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const NOW = Date.parse("2026-11-16T12:00:00.000Z");
  const record = (ageSeconds: number, state: "ok" | "low" = "ok", version = 1) => ({
    version,
    observedAt: new Date(NOW - ageSeconds * 1000).toISOString(),
    state,
    volumes: only(volume(500 * GiB, 1000 * GiB)),
  });
  let n = 0;
  const file = (content: string): string => {
    const path = join(directory, `capacity-${String((n += 1))}.json`);
    writeFileSync(path, content);
    return path;
  };

  it("missing, a directory, 5,000 bytes, not JSON, a wrong version, 181 s old: unknown with its cause", async () => {
    const dir = join(directory, "a-directory");
    mkdirSync(dir);
    const cases: [string, string][] = [
      [join(directory, "absent.json"), "missing"],
      [dir, "invalid"],
      [file(" ".repeat(5000)), "invalid"],
      [file("{not json"), "invalid"],
      [file(JSON.stringify(record(10, "ok", 2))), "invalid"],
      [file(JSON.stringify({ ...record(10), extra: 1 })), "invalid"],
      [file(JSON.stringify(record(181))), "stale"],
    ];
    for (const [path, cause] of cases) {
      expect(await readCapacity(path, NOW), cause).toEqual({ kind: "unknown", cause });
    }
  });

  it("a file the API may not open: unknown, unreadable", async () => {
    const path = file(JSON.stringify(record(10)));
    const denied = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(await readCapacity(path, NOW, { openSync: denied })).toEqual({
      kind: "unknown",
      cause: "unreadable",
    });
  });

  it("179 s old: the stored state", async () => {
    expect(await readCapacity(file(JSON.stringify(record(179, "ok"))), NOW)).toEqual({
      kind: "ok",
    });
    expect(await readCapacity(file(JSON.stringify(record(179, "low"))), NOW)).toEqual({
      kind: "low",
    });
  });
});

describe("every mutation is classified (P-115)", () => {
  const authSource = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "packages", "auth", "src", "routes.ts"),
    "utf8",
  );
  /** The auth module's writing paths, as `POST /v1/auth/<path>`. */
  const authWrites = [
    ...authSource.matchAll(/app\.(post|put|patch|delete)\(`\$\{base\}([^`]+)`/g),
  ].map((match) => `${(match[1] ?? "").toUpperCase()} /v1/auth${match[2] ?? ""}`);

  it("every idempotent route and every writing auth path is in exactly one of the two sets", () => {
    expect(authWrites.length).toBeGreaterThanOrEqual(10);
    const mutations = [
      ...ROUTES.filter((route) => route.idempotent).map((route) => route.id),
      ...authWrites,
    ];
    for (const id of mutations) {
      const expanding = EXPANDING_ROUTES.has(id);
      const reducing = REDUCING_ROUTES.has(id);
      expect(expanding !== reducing, id).toBe(true);
    }
    for (const id of [...EXPANDING_ROUTES, ...REDUCING_ROUTES]) {
      const known = ROUTES.some((route) => route.id === id) || authWrites.includes(id);
      expect(known, id).toBe(true);
    }
  });

  it("the expanding contract routes can answer 507 capacity_exceeded", () => {
    for (const route of ROUTES.filter((candidate) => EXPANDING_ROUTES.has(candidate.id))) {
      expect(route.errors, route.id).toContain("capacity_exceeded");
    }
  });

  it("the routes that reduce exposure, sign-in and its factors continue", () => {
    for (const id of [
      "projects.archive",
      "environments.archive",
      "credentials.revoke",
      "POST /v1/auth/sign-in/email",
      "POST /v1/auth/sign-out",
      "POST /v1/auth/revoke-sessions",
      "POST /v1/auth/sessions/revoke",
      "POST /v1/auth/totp/verify",
    ]) {
      expect(REDUCING_ROUTES.has(id), id).toBe(true);
    }
    for (const id of [
      "secrets.create",
      "credentials.issue",
      "POST /v1/auth/change-password",
      "POST /v1/auth/totp/enroll",
    ]) {
      expect(EXPANDING_ROUTES.has(id), id).toBe(true);
    }
  });
});
