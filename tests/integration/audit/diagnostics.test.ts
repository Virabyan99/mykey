// Run 6.1 Task C (P-109, FR-1.59, FR-1.80, Review focus 4): the canary
// sweep. A journey runs with run-time canaries as secret values, passwords,
// submitted factor codes and an incoming request id, and collects the
// credentials it is handed (session cookies, a machine token, a reset link's
// token, recovery codes). Afterwards none of these bytes is in the API's log,
// the PostgreSQL and OpenBao container logs, any audit row or any error body.
// Controls: a marker planted in each place the same way is found.
// TOTP codes themselves are six digits and would match any timestamp; the
// sweep sends canary-shaped codes instead (the body allows 64 characters).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createThrottle } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import { signInComplete } from "../../harness/api.ts";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall } from "../../harness/machine.ts";
import { serviceLog } from "../../harness/stack.ts";

let f: CredentialsFixture;
let since: string;

beforeAll(async () => {
  f = await createCredentialsFixture();
  since = new Date(Date.now() - 60_000).toISOString();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

/** Every place a canary must not be, as one text per place. */
async function places(): Promise<Record<string, string>> {
  const audit = await f.api.superuser.query<{ row: string }>(
    "SELECT row_to_json(e)::text AS row FROM audit.event e",
  );
  return {
    api: JSON.stringify(f.api.logs),
    postgres: await serviceLog(f.stack, "postgres", since),
    openbao: await serviceLog(f.stack, "openbao", since),
    audit: audit.rows.map((row) => row.row).join("\n"),
  };
}

describe("the canary sweep (P-109)", () => {
  it("no secret, password, code, link, token or foreign request id reaches a log, an audit row or an error body", async () => {
    const needles: string[] = [];
    const errors: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async (...args: Parameters<typeof request>) => {
      const response = await request(...args);
      if (response.status >= 400) errors.push(await response.clone().text());
      return response;
    };
    const source = () => `198.51.100.${String(20 + needles.length)}`;
    try {
      await f.api.superuser.query("DELETE FROM app.rate_limit");
      // Secret values: create, update, import, then read back three ways.
      const path = f.env("env1a").path;
      const name = `DIAG_${randomBytes(4).toString("hex").toUpperCase()}`;
      const first = canary();
      const second = canary();
      needles.push(first, second);
      const created = await f.create("env1a", name, first);
      expect(created.status).toBe(201);
      const updated = await f.update(
        "env1a",
        name,
        second,
        created.body.result as { version: number; stateTag: string },
      );
      expect(updated.status).toBe(200);
      const imported = canary();
      needles.push(imported);
      const preview = await f.send("POST", `${path}/import/preview`, {
        text: `DIAG_IMPORT_${randomBytes(3).toString("hex").toUpperCase()}=${imported}\n`,
        key: null,
      });
      expect(preview.status).toBe(200);
      expect(
        (await f.send("POST", `${path}/secrets/${name}/reveal`, { body: {}, key: null })).status,
      ).toBe(200);
      await f.freshen();
      expect(
        (await f.send("POST", `${path}/export`, { body: { confirmed: true }, key: null })).status,
      ).toBe(200);

      // A machine token, and the values it reads.
      const issued = await issueFor(f, "env1a");
      needles.push(issued.token);
      expect((await machineCall(f, "resolve", { token: issued.token })).status).toBe(200);
      // A wrong token shaped like a real one.
      const wrongToken = `s.${canary()}`;
      needles.push(wrongToken);
      expect((await machineCall(f, "keys", { token: wrongToken })).status).toBe(401);

      // Passwords, codes and sessions.
      const credentials = f.tenants.credentials("readerA");
      const session = await signInComplete(f.api, credentials, { source: source() });
      needles.push(decodeURIComponent(session.cookie.split("=")[1] ?? "").split(".")[0] ?? "");
      const wrongPassword = canary();
      needles.push(wrongPassword);
      expect(
        (
          await f.api.request("POST", "/v1/auth/sign-in/email", {
            body: { email: credentials.email, password: wrongPassword },
            headers: { "x-forwarded-for": source() },
          })
        ).status,
      ).toBe(401);
      const newPassword = `${canary()}-pw`;
      needles.push(newPassword);
      const changed = await f.api.request("POST", "/v1/auth/change-password", {
        body: { currentPassword: credentials.password, newPassword },
        cookie: session.cookie,
        headers: { "x-forwarded-for": source() },
      });
      expect(changed.status).toBe(200);
      const wrongCode = canary();
      needles.push(wrongCode);
      expect(
        (
          await f.api.request("POST", "/v1/auth/totp/step-up", {
            body: { code: wrongCode },
            cookie: session.cookie,
            headers: { "x-forwarded-for": source() },
          })
        ).status,
      ).toBe(401);
      const regenerated = await f.api.request("POST", "/v1/auth/recovery/regenerate", {
        body: {},
        cookie: session.cookie,
        headers: { "x-forwarded-for": source() },
      });
      if (regenerated.status === 200) {
        const codes = ((await regenerated.json()) as { recoveryCodes?: string[] }).recoveryCodes;
        needles.push(...(codes ?? []).filter((code) => code.length >= 8));
      }

      // A reset link's token, used once and once wrongly.
      const maintenance = f.api.database.pool("maintenance");
      const reset = await initiateReset(
        {
          pool: maintenance,
          keys: f.api.keys,
          throttle: createThrottle({ pool: maintenance, ring: f.api.keys.rateLimit }),
        },
        { email: f.tenants.credentials("envEditorA").email, kind: "password" },
      );
      expect(reset.outcome).toBe("issued");
      if (reset.outcome === "issued") needles.push(reset.token);
      const resetPassword = `${canary()}-reset`;
      needles.push(resetPassword);
      const wrongLink = `${canary()}AAAAAAAAAA`.slice(0, 43);
      needles.push(wrongLink);
      await f.api.request("POST", "/v1/auth/reset/complete", {
        body: { token: wrongLink, newPassword: resetPassword, code: canary() },
        headers: { "x-forwarded-for": source() },
      });

      // An incoming request id is never taken, echoed or logged.
      const foreignId = canary();
      needles.push(foreignId);
      const echoed = await f.api.request("GET", "/v1/organizations", {
        cookie: await f.tenants.cookie("ownerA"),
        headers: { "x-request-id": foreignId },
      });
      expect(echoed.status).toBe(200);
      expect(echoed.headers.get("x-request-id")).not.toBe(foreignId);
      expect(echoed.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      f.api.request = request;
    }

    const where = await places();
    const found: string[] = [];
    for (const needle of needles.filter((needle) => needle.length >= 8)) {
      for (const [place, text] of Object.entries(where)) {
        if (text.includes(needle))
          found.push(`${place}: needle ${String(needles.indexOf(needle))}`);
      }
      errors.forEach((body, i) => {
        if (body.includes(needle))
          found.push(`error body ${String(i)}: needle ${String(needles.indexOf(needle))}`);
      });
    }
    expect(needles.length).toBeGreaterThan(12);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(found).toEqual([]);
  }, 600_000);

  it("control: a marker planted in each place is found by the same search", async () => {
    const marker = canary();
    f.api.logs.push({ event: "listening", port: 1, note: marker } as never);
    // PostgreSQL logs the text of a statement that fails: a value inlined in SQL would land there.
    await f.api.superuser.query(`SELECT 1/0 AS "${marker}"`).catch(() => undefined);
    await f.api.superuser.query(
      `INSERT INTO audit.event (id, actor_kind, organization_id, action, outcome, details)
       VALUES ($1, 'system', NULL, 'operator.auth_cleanup', 'success', jsonb_build_object('marker', $2::text))`,
      [randomUUID(), marker],
    );
    const where = await places();
    for (const place of ["api", "postgres", "audit"]) {
      expect(where[place]?.includes(marker), place).toBe(true);
    }
    // OpenBao's server log of this window holds this fixture's namespace (its mounts at setup):
    // the search reads the window the journey wrote in.
    expect(where.openbao?.includes(`org-${f.tenants.a.organizationId}`), "openbao").toBe(true);
    f.api.logs.pop();
  });
});

describe("runtime cannot change audit (P-109)", () => {
  it("api_runtime and provisioner_runtime get 42501 for UPDATE, DELETE and TRUNCATE on audit.event", async () => {
    for (const role of ["api_runtime", "provisioner_runtime"] as const) {
      const pool = f.api.database.pool(role);
      for (const statement of [
        "UPDATE audit.event SET outcome = 'success' WHERE false",
        "DELETE FROM audit.event WHERE false",
        "TRUNCATE audit.event",
      ]) {
        const error = await pool.query(statement).then(
          () => null,
          (caught: unknown) => caught as { code?: string },
        );
        expect(error?.code, `${role}: ${statement}`).toBe("42501");
      }
    }
  });
});
