// Run 2.3 Task A: only the allowed native routes answer; every other path
// under /v1/auth is the contract's 404 and writes nothing (P-25).
import { errorEnvelopeSchema } from "@mykey/contracts";
import { NATIVE_DENIED } from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../database/setup.ts";
import {
  authFixture,
  authRowCounts,
  cookieOf,
  type AuthFixture,
  type SeededUser,
} from "./fixture.ts";

let fixture: AuthFixture;
let user: SeededUser;
let passwordCookie: string;
let elevatedCookie: string;

beforeAll(async () => {
  fixture = await authFixture();
  user = await fixture.seedUser();
  passwordCookie = await fixture.signIn(user);
  elevatedCookie = await fixture.signIn(user);
  // A session that has completed the second factor, made directly in the
  // database: the factor routes arrive in Task D.
  await run(
    fixture.db.pool("superuser"),
    "UPDATE auth.session SET phase = 'mfa_complete' WHERE id = (SELECT id FROM auth.session ORDER BY created_at DESC LIMIT 1)",
  );
});

afterAll(async () => {
  await fixture.close();
});

async function expectNotFound(response: Response, what: string): Promise<void> {
  expect(response.status, what).toBe(404);
  const envelope = errorEnvelopeSchema.parse(await response.json());
  expect(envelope.error.code, what).toBe("not_found");
}

/** A realistic body for each denied route, so a 404 is not a body error. */
const BODIES: Record<string, unknown> = {
  "/sign-up/email": { email: "new@example.test", password: "a-long-password-1", name: "New" },
  "/request-password-reset": { email: "owner@example.test", redirectTo: "/reset" },
  "/reset-password": { newPassword: "a-long-password-2", token: "x" },
  "/update-user": { name: "Renamed" },
  "/change-email": { newEmail: "other@example.test" },
  "/delete-user": { password: "x" },
  "/revoke-session": { token: "x" },
  "/sign-in/social": { provider: "github" },
  "/verify-password": { password: "x" },
  "/update-session": { phase: "mfa_complete" },
};

describe("denied native routes", () => {
  it("answer 404 with the not_found envelope and create no row, with or without a session", async () => {
    const before = await authRowCounts(fixture.pool);
    for (const route of NATIVE_DENIED) {
      const path = `/v1/auth${route.path.replaceAll(/:[a-z]+/g, "x")}`;
      for (const cookie of [undefined, passwordCookie, elevatedCookie]) {
        const response = await fixture.request(route.method, path, {
          ...(route.method === "POST" ? { body: BODIES[route.path] ?? {} } : {}),
          ...(cookie === undefined ? {} : { cookie }),
        });
        await expectNotFound(
          response,
          `${route.method} ${path} ${cookie === undefined ? "" : "with session"}`,
        );
      }
    }
    expect(await authRowCounts(fixture.pool)).toEqual(before);
  });

  it("include the paths of the stock two-factor plugin, which is not installed", async () => {
    for (const path of ["/two-factor/disable", "/two-factor/enable", "/two-factor/verify-totp"]) {
      await expectNotFound(
        await fixture.request("POST", `/v1/auth${path}`, {
          body: { code: "123456" },
          cookie: elevatedCookie,
        }),
        path,
      );
    }
  });

  it("do not open through doubled or trailing slashes", async () => {
    for (const path of [
      "/v1/auth//sign-up/email",
      "/v1/auth/sign-up/email/",
      "/v1/auth/sign-in/email/",
    ]) {
      await expectNotFound(
        await fixture.request("POST", path, { body: BODIES["/sign-up/email"] }),
        path,
      );
    }
  });

  it("sign-up is refused even when called in-process", async () => {
    const before = await authRowCounts(fixture.pool);
    await expect(
      fixture.auth.api.signUpEmail({
        body: {
          email: "inprocess@example.test",
          password: "a-long-password-3",
          name: "In Process",
        },
      }),
    ).rejects.toThrow();
    expect(await authRowCounts(fixture.pool)).toEqual(before);
  });
});

describe("allowed native routes", () => {
  it("sign-in answers 200, sets one session cookie and returns no token (control)", async () => {
    const response = await fixture.request("POST", "/v1/auth/sign-in/email", {
      body: { email: user.email, password: user.password },
    });
    expect(response.status).toBe(200);
    expect(
      response.headers.getSetCookie().filter((cookie) => cookie.includes("session_token")),
    ).toHaveLength(1);
    expect(cookieOf(response)).toBeDefined();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    expect(body.user).toMatchObject({ id: user.id, email: user.email });
  });

  it("sign-in with a wrong password is 401 unauthenticated and sets no cookie", async () => {
    const response = await fixture.request("POST", "/v1/auth/sign-in/email", {
      body: { email: user.email, password: `${user.password}x` },
    });
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe("unauthenticated");
    expect(cookieOf(response)).toBeUndefined();
  });

  it("refuses unknown body fields as 400 malformed_request", async () => {
    for (const extra of [{ rememberMe: false }, { callbackURL: "https://evil.test" }]) {
      const response = await fixture.request("POST", "/v1/auth/sign-in/email", {
        body: { email: user.email, password: user.password, ...extra },
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe("malformed_request");
    }
  });

  it("get-session resolves a cookie and returns no token", async () => {
    const response = await fixture.request("GET", "/v1/auth/get-session", {
      cookie: passwordCookie,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: Record<string, unknown>;
      user: { id: string };
    };
    expect(body.user.id).toBe(user.id);
    expect(body.session).not.toHaveProperty("token");
    expect(body.session.phase).toBe("password_verified");
  });
});
