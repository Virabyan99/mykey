// Run 2.3 Task A, moved onto the integrated app in Run 3.2 Task C: only the
// allowed native routes answer; every other path under /v1/auth is the
// contract's 404 — with the pipeline's request id and no-store — and writes
// nothing (P-25). No route of the app creates a user.
import { errorEnvelopeSchema } from "@mykey/contracts";
import { NATIVE_DENIED } from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOwner, startTestApi, type TestApi } from "../../harness/api.ts";
import { authRowCounts } from "./fixture.ts";

const COOKIE = "__Secure-better-auth.session_token";

let api: TestApi;
let owner: Awaited<ReturnType<typeof seedOwner>>;
let passwordCookie: string;
let elevatedCookie: string;

async function signIn(): Promise<string> {
  const response = await api.request("POST", "/v1/auth/sign-in/email", {
    body: { email: owner.email, password: owner.password },
  });
  expect(response.status).toBe(200);
  const pair = (response.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  expect(pair.startsWith(`${COOKIE}=`)).toBe(true);
  return pair;
}

beforeAll(async () => {
  api = await startTestApi();
  owner = await seedOwner(api);
  passwordCookie = await signIn();
  elevatedCookie = await signIn();
  // A session that has completed the second factor, made directly in the
  // database (the factor routes join the pipeline in Run 3.4).
  await api.superuser.query(
    "UPDATE auth.session SET phase = 'mfa_complete' WHERE id = (SELECT id FROM auth.session ORDER BY created_at DESC LIMIT 1)",
  );
  await api.superuser.query("UPDATE auth.account_state SET state = 'active' WHERE user_id = $1", [
    owner.userId,
  ]);
});

afterAll(async () => {
  await api.close();
});

async function expectNotFound(response: Response, what: string): Promise<void> {
  expect(response.status, what).toBe(404);
  expect(response.headers.get("cache-control"), what).toBe("no-store");
  const envelope = errorEnvelopeSchema.parse(await response.json());
  expect(envelope.error.code, what).toBe("not_found");
  // The pipeline's request id, not one the auth module made up.
  expect(envelope.error.requestId, what).toBe(response.headers.get("x-request-id"));
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
    const before = await authRowCounts(api.superuser);
    for (const route of NATIVE_DENIED) {
      const path = `/v1/auth${route.path.replaceAll(/:[a-z]+/g, "x")}`;
      for (const cookie of [undefined, passwordCookie, elevatedCookie]) {
        const response = await api.request(route.method, path, {
          ...(route.method === "POST" ? { body: BODIES[route.path] ?? {} } : {}),
          ...(cookie === undefined ? {} : { cookie }),
        });
        await expectNotFound(
          response,
          `${route.method} ${path} ${cookie === undefined ? "" : "with session"}`,
        );
      }
    }
    expect(await authRowCounts(api.superuser)).toEqual(before);
  });

  it("sign-up with a valid owner cookie and the right Origin is still 404", async () => {
    const before = await authRowCounts(api.superuser);
    await expectNotFound(
      await api.request("POST", "/v1/auth/sign-up/email", {
        body: BODIES["/sign-up/email"],
        cookie: elevatedCookie,
        headers: { origin: api.origin },
      }),
      "sign-up",
    );
    expect(await authRowCounts(api.superuser)).toEqual(before);
  });

  it("include the paths of the stock two-factor plugin, which is not installed", async () => {
    for (const path of ["/two-factor/disable", "/two-factor/enable", "/two-factor/verify-totp"]) {
      await expectNotFound(
        await api.request("POST", `/v1/auth${path}`, {
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
        await api.request("POST", path, { body: BODIES["/sign-up/email"] }),
        path,
      );
    }
  });

  it("sign-up is refused even when called in-process", async () => {
    const before = await authRowCounts(api.superuser);
    await expect(
      api.auth.api.signUpEmail({
        body: {
          email: "inprocess@example.test",
          password: "a-long-password-3",
          name: "In Process",
        },
      }),
    ).rejects.toThrow();
    expect(await authRowCounts(api.superuser)).toEqual(before);
  });

  it("no mounted path of the app creates a user", () => {
    const creating = api.routes.filter((route) =>
      /sign-up|register|invite|accept/i.test(route.path),
    );
    expect(creating).toEqual([]);
    // Control: the listing holds the auth routes.
    expect(api.routes).toContainEqual({ method: "POST", path: "/v1/auth/sign-in/email" });
  });
});

describe("allowed native routes", () => {
  it("refuses unknown body fields as 400 malformed_request", async () => {
    for (const extra of [{ rememberMe: false }, { callbackURL: "https://evil.test" }]) {
      const response = await api.request("POST", "/v1/auth/sign-in/email", {
        body: { email: owner.email, password: owner.password, ...extra },
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe("malformed_request");
    }
  });

  it("get-session resolves a cookie and returns no token", async () => {
    const response = await api.request("GET", "/v1/auth/get-session", { cookie: passwordCookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: Record<string, unknown>;
      user: { id: string };
    };
    expect(body.user.id).toBe(owner.userId);
    expect(body.session).not.toHaveProperty("token");
    expect(body.session.phase).toBe("password_verified");
  });
});
