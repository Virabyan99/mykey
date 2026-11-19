// Run 7.10 (Doc 10 §4.5; FR-1.89): one owner, one browser page, from the
// sign-in form to a revoked token and the sign-out. Chromium against the real
// API, PostgreSQL, OpenBao and the real provisioning job. Every step asserts
// what the server then says (tests/harness/journey.ts); nothing is mocked.
import { randomBytes } from "node:crypto";
import { stepAt } from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticator,
  journeyValues,
  ownerJourney,
  signInByForm,
  signOutByButton,
} from "../harness/journey.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;
let provisioner: Awaited<ReturnType<StoresWeb["f"]["fx"]["start"]>> | null = null;
/** Steps at which the fixture may have used a seed's code. */
const fixtureSteps: number[] = [];

beforeAll(async () => {
  const before = stepAt(new Date());
  web = await startWebWithStores();
  for (let step = before - 1; step <= stepAt(new Date()) + 1; step += 1) fixtureSteps.push(step);
  provisioner = await web.f.fx.start();
}, 600_000);

afterAll(async () => {
  await provisioner?.stop();
  await web.close();
});

const SESSION_COOKIE = "__Secure-better-auth.session_token";

describe("the owner's journey", () => {
  it("sign in, a project, an environment, secrets, an import, an export, a token issued, used and revoked, the activity, sign out", async () => {
    const account = web.tenants.credentials("ownerA");
    const userId = web.tenants.userId("ownerA");
    const codes = authenticator(account.seed, fixtureSteps);
    const db = web.api.superuser;
    const sessions = async (): Promise<string[]> =>
      (
        await db.query<{ id: string }>(
          "SELECT id::text AS id FROM auth.session WHERE user_id = $1 ORDER BY id",
          [userId],
        )
      ).rows.map((row) => row.id);
    await db.query("DELETE FROM app.rate_limit");

    const session = await web.anonymous();
    const { page } = session;
    try {
      const before = await sessions();
      await page.goto(`${web.origin}/`);
      await signInByForm(page, account, codes.next);
      // The server has one more session of this owner, verified with a code.
      const mine = (await sessions()).filter((id) => !before.includes(id));
      expect(mine).toHaveLength(1);
      const verified = await db.query<{ fresh: boolean }>(
        "SELECT totp_verified_at IS NOT NULL AS fresh FROM auth.session WHERE id = $1",
        [mine[0]],
      );
      expect(verified.rows[0]?.fresh).toBe(true);

      const values = journeyValues(() => `journey value ${randomBytes(12).toString("hex")}`, {
        userId,
        code: codes.next,
      });
      await ownerJourney(web, page, values);

      const held = (await session.context.cookies()).find(
        (cookie) => cookie.name === SESSION_COOKIE,
      );
      if (held === undefined) throw new Error("the browser holds no session cookie");
      const cookie = `${held.name}=${held.value}`;
      expect((await web.api.request("GET", "/v1/organizations", { cookie })).status).toBe(200);
      await signOutByButton(page);
      // The server ended that session: its row is gone and its cookie opens nothing.
      expect((await sessions()).includes(mine[0] ?? "")).toBe(false);
      expect((await web.api.request("GET", "/v1/organizations", { cookie })).status).toBe(401);

      expect(session.thirdParty).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 900_000);
});
