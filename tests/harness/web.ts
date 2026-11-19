// The workspace in a real browser (Session 7). `startWeb()` builds the
// workspace into a temporary directory, starts the test API with it, creates
// the tenants and launches Chromium.
//
// The origin is real (Review focus 2). The test API believes it serves
// TEST_ORIGIN and checks the Origin header of every change against it, while
// it listens on 127.0.0.1:<port>. Chromium is started with a resolver rule
// that sends TEST_ORIGIN's host to that port, so the page's address, its
// Origin header and its cookie are all those of TEST_ORIGIN, and no test
// rewrites a header. The API's certificate is the stack's private one: the
// context accepts it (this is not a test of TLS).
// Needs Chromium: `pnpm exec playwright install chromium` (once per workstation or runner).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildWeb } from "../../apps/web/build.ts";
import { startTestApi, TEST_ORIGIN, type StartTestApiOptions, type TestApi } from "./api.ts";
import { createCredentialsFixture, type CredentialsFixture } from "./credentials-fixture.ts";
import { createTenants, type FixtureUser, type Tenants } from "./tenants.ts";

export interface Capture {
  violations: { directive: string; blocked: string }[];
}

// Runs before any script of the page (through the DevTools protocol, outside the page's policy).
const INIT = `(() => {
  const capture = { violations: [] };
  Object.defineProperty(window, "__capture", { value: capture });
  document.addEventListener("securitypolicyviolation", (event) => {
    capture.violations.push({ directive: event.violatedDirective, blocked: String(event.blockedURI) });
  }, true);
})();`;

export interface WebSession {
  context: BrowserContext;
  page: Page;
  /** Every request the context started, in order (data: addresses are not requests). */
  requested: string[];
  /** Requests to another origin: each was aborted. */
  thirdParty: string[];
  /** The policy violations of the page as it is now. */
  violations(): Promise<Capture["violations"]>;
  /** The path and query of the page's address. */
  path(): string;
  close(): Promise<void>;
}

export interface Web {
  api: TestApi;
  tenants: Tenants;
  browser: Browser;
  /** The origin the browser uses and the API checks: TEST_ORIGIN. */
  origin: string;
  /** A page with the complete session of a tenant user. */
  signedIn(user: FixtureUser): Promise<WebSession>;
  /** A page with no cookie. */
  anonymous(): Promise<WebSession>;
  /** A page with this `name=value` session cookie (a password-only session, a second session). */
  withCookie(pair: string): Promise<WebSession>;
  /**
   * A new account of organization A that has a password and no authenticator
   * yet (`enrollment_pending`), made as the tenants fixture makes its users.
   */
  pendingUser(): Promise<{ id: string; email: string; password: string }>;
  close(): Promise<void>;
}

export async function startWeb(options: StartTestApiOptions = {}): Promise<Web> {
  return assemble(async (directory, cleanup) => {
    const api = await startTestApi({
      ...options,
      config: { ...options.config, webDirectory: directory },
    });
    cleanup.push(() => api.close());
    return { api, tenants: await createTenants(api) };
  });
}

/** The workspace over both stores: OpenBao, the provisioner's objects and machine credentials. */
export interface StoresWeb extends Web {
  f: CredentialsFixture;
}

/**
 * The workspace served by the API of the credentials fixture (Run 7.3 on):
 * real OpenBao, environments made by the real provisioning job, real tokens.
 */
export async function startWebWithStores(): Promise<StoresWeb> {
  let fixture: CredentialsFixture | undefined;
  const web = await assemble(async (directory, cleanup) => {
    const f = await createCredentialsFixture({ webDirectory: directory });
    cleanup.push(() => f.close());
    fixture = f;
    return { api: f.api, tenants: f.tenants };
  });
  if (fixture === undefined) throw new Error("no fixture");
  return { ...web, f: fixture };
}

async function assemble(
  start: (
    directory: string,
    cleanup: (() => Promise<void> | void)[],
  ) => Promise<{ api: TestApi; tenants: Tenants }>,
): Promise<Web> {
  const directory = mkdtempSync(join(tmpdir(), "mykey-web-"));
  const cleanup: (() => Promise<void> | void)[] = [
    () => {
      rmSync(directory, { recursive: true, force: true });
    },
  ];
  const close = async (): Promise<void> => {
    for (const step of cleanup.reverse()) await step();
  };
  try {
    await buildWeb({ directory, build: "test" });
    const { api, tenants } = await start(directory, cleanup);
    const host = new URL(TEST_ORIGIN).host;
    const browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${host} 127.0.0.1:${String(api.port)}`],
    });
    cleanup.push(() => browser.close());

    const open = async (pair: string | null): Promise<WebSession> => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
      });
      // The API is local: what is not there after 15 seconds will not come.
      context.setDefaultTimeout(15_000);
      if (pair !== null) {
        const at = pair.indexOf("=");
        await context.addCookies([
          {
            name: pair.slice(0, at),
            value: pair.slice(at + 1),
            url: TEST_ORIGIN,
            secure: true,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      }
      const requested: string[] = [];
      const thirdParty: string[] = [];
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (new URL(url).origin === TEST_ORIGIN) {
          await route.continue();
        } else {
          thirdParty.push(url);
          await route.abort("blockedbyclient");
        }
      });
      context.on("request", (request) => {
        if (!request.url().startsWith("data:")) requested.push(request.url());
      });
      await context.addInitScript({ content: INIT });
      const page = await context.newPage();
      return {
        context,
        page,
        requested,
        thirdParty,
        // No DOM types in the tests' TypeScript: the page's global object is globalThis there.
        violations: async () =>
          (await page.evaluate(() => (globalThis as unknown as { __capture: Capture }).__capture))
            .violations,
        path: () => {
          const url = new URL(page.url());
          return `${url.pathname}${url.search}`;
        },
        close: () => context.close(),
      };
    };

    return {
      api,
      tenants,
      browser,
      origin: TEST_ORIGIN,
      signedIn: async (user) => open(await tenants.cookie(user)),
      anonymous: () => open(null),
      withCookie: (pair) => open(pair),
      pendingUser: async () => {
        const id = randomUUID();
        const email = `pending-${randomBytes(3).toString("hex")}@mykey.invalid`;
        const password = randomBytes(18).toString("base64url");
        const hasher = (await api.auth.$context).password;
        const db = api.superuser;
        await db.query(
          `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
          [id, "pending", email],
        );
        await db.query(
          `INSERT INTO auth.account (id, account_id, provider_id, user_id, password)
           VALUES (gen_random_uuid(), $1, 'credential', $2, $3)`,
          [id, id, await hasher.hash(password)],
        );
        await db.query(
          "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
          [id],
        );
        await db.query(
          `INSERT INTO app.membership (id, organization_id, user_id, role, state)
           VALUES (gen_random_uuid(), $1, $2, 'admin', 'active')`,
          [tenants.a.organizationId, id],
        );
        return { id, email, password };
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
