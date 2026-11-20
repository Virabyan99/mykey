// Run 7.8 (FR-1.92, FR-1.94, AC-1.48, AC-1.55, P-140, P-142): operations,
// the activity timeline, the audit view and the summary, over real OpenBao.
// The page shows the server's word for a state and never turns "not known"
// into "failed"; a day that was not measured is not a zero; nothing on these
// screens can settle an operation. The delayed write, the unknown issuance,
// the interrupted import and the uncertain write are made by the product
// with the fixtures' fault hooks; only audit rows of earlier days are written
// directly (an audit row cannot be back-dated afterwards).
import { randomBytes, randomUUID } from "node:crypto";
import type { AuditAction } from "@mykey/audit";
import { webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DETAILS_OF } from "../harness/audit-fixture.ts";
import { clearCredentials } from "../harness/credentials-fixture.ts";
import type { FixtureUser } from "../harness/tenants.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

beforeEach(async () => {
  await web.api.superuser.query("DELETE FROM app.rate_limit");
  await web.f.freshen();
});

afterEach(async () => {
  web.f.setFaults(null);
  web.f.setImportBudget(null);
  await clearCredentials(web.f, web.tenants.a.env1a);
});

const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const valueOf = (): string => `${mark}-${randomBytes(4).toString("hex")}`;
const newName = (): string => `ACT_${randomBytes(5).toString("hex").toUpperCase()}`;
const org = (): string => web.tenants.a.organizationId;
const at = () => ({ org: org(), project: web.tenants.a.project1, env: web.tenants.a.env1a });

const DAY_MS = 86_400_000;
const today = (): number => Math.floor(Date.now() / DAY_MS) * DAY_MS;
const noon = (daysAgo: number): Date => new Date(today() - daysAgo * DAY_MS + DAY_MS / 2);
const dayOf = (daysAgo: number): string =>
  new Date(today() - daysAgo * DAY_MS).toISOString().slice(0, 10);

/** One audit row of organization A at `at`. */
async function auditRow(action: AuditAction, outcome: string, at: Date): Promise<void> {
  await web.api.superuser.query(
    `INSERT INTO audit.event (id, occurred_at, actor_kind, actor_id, source_category,
                              organization_id, action, target_kind, target_id, outcome,
                              request_id, details)
     VALUES ($1, $2, 'user', $3, 'api', $4::uuid, $5, 'organization', $4::text, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      at,
      web.tenants.userId("ownerA"),
      org(),
      action,
      outcome,
      randomUUID(),
      JSON.stringify(DETAILS_OF[action]),
    ],
  );
}

async function open(page: Page, route: "operations" | "activity" | "audit" | "overview") {
  const titles = {
    operations: "Operations",
    activity: "Activity",
    audit: "Audit",
    overview: "Overview",
  };
  const path = route === "operations" ? webPath(route, at()) : webPath(route, { org: org() });
  await page.goto(`${web.origin}${path}`);
  await page.getByRole("heading", { level: 1, name: titles[route] }).waitFor();
}

const rowWith = (page: Page, table: string, text: string): Locator =>
  page.getByRole("table", { name: table }).locator("tbody tr").filter({ hasText: text });

const apiPaths = (requested: readonly string[]): string[] =>
  requested.map((url) => new URL(url)).map((url) => `${url.pathname}${url.search}`);

describe("operations", () => {
  it("a delayed write is shown executing, then succeeded, without a reload", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      reached = resolve;
    });
    web.f.setFaults(async (point) => {
      if (point === "after_dispatch_marker") {
        reached();
        await held;
      }
    });
    const name = newName();
    const pending = web.f.create("env1a", name, valueOf());
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await sent;
      await open(page, "operations");
      const row = rowWith(page, "Operations", name);
      await row.locator(".badge", { hasText: "executing" }).waitFor();
      expect(await row.textContent()).toContain("you");
      await page.getByText(/The server is still working/).waitFor();
      // A mark on the document: a reload would lose it.
      await page.evaluate("window.__opened = 1");

      release();
      expect((await pending).status).toBe(201);
      // The page asks again by itself: after 1 s, 2 s, 4 s.
      await row.locator(".badge", { hasText: "succeeded" }).waitFor({ timeout: 30_000 });
      expect(await page.evaluate("window.__opened")).toBe(1);
      expect(await session.violations()).toEqual([]);
    } finally {
      release();
      await pending.catch(() => undefined);
      await session.close();
    }
  }, 240_000);

  it("an unknown issuance is shown as needs_review with the operator sentence and no retry", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = `unknown ${randomBytes(3).toString("hex")}`;
    try {
      await page.goto(`${web.origin}${webPath("credentials", at())}`);
      await page.getByRole("button", { name: "New credential" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      web.f.setFaults((point) => {
        if (point === "after_marker") throw new Error("fault");
      });
      await page.getByRole("button", { name: "Issue credential", exact: true }).click();
      const alert = page
        .getByRole("alert")
        .filter({ has: page.getByRole("heading", { name: "The outcome is not known" }) });
      await alert.waitFor({ timeout: 60_000 });
      web.f.setFaults(null);
      expect(await alert.textContent()).toMatch(/Do not enter it a second time/);
      expect(await alert.textContent()).toMatch(/An operator settles this from the host/);
      const operationId = (await alert.locator("dd code").last().textContent()) ?? "";
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
      // No token, and nothing that sends the issuance again.
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);
      const row = rowWith(page, "Machine credentials", name);
      await row.locator(".badge", { hasText: "needs review" }).waitFor();
      expect(await row.textContent()).toMatch(/An operator settles this/);
      expect(await row.getByRole("button").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Issue credential" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "New credential" }).count()).toBe(0);

      // The panel leads to the operation, which says the same.
      await alert.getByRole("link", { name: "Operations of this environment" }).click();
      await page.getByRole("heading", { level: 1, name: "Operations" }).waitFor();
      const operation = rowWith(page, "Operations", operationId);
      await operation.locator(".badge", { hasText: "uncertain" }).waitFor();
      expect(await operation.textContent()).toMatch(/An operator settles this/);
      expect(await operation.getByRole("button").allTextContents()).toEqual(["Details"]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("an interrupted import is shown awaiting_input with resume", async () => {
    const text = [newName(), newName(), newName()].map((name) => `${name}=${valueOf()}\n`).join("");
    const path = web.f.env("env1a").path;
    const preview = await web.f.send("POST", `${path}/import/preview`, { text, key: null });
    expect(preview.status, preview.code ?? "").toBe(200);
    web.f.setImportBudget(0);
    const applied = await web.f.send(
      "POST",
      `${path}/import/${String(preview.body.previewId)}/apply`,
      { text },
    );
    web.f.setImportBudget(null);
    expect(applied.status, applied.code ?? "").toBe(202);
    const operationId = String(applied.body.operationId);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await open(page, "operations");
      const row = rowWith(page, "Operations", operationId);
      await row.locator(".badge", { hasText: "awaiting input" }).waitFor();
      expect(await row.textContent()).toMatch(/waits for the file/);
      // Nothing is asked again for it: the server will not move it by itself.
      expect(await page.getByText(/The server is still working/).count()).toBe(0);
      await row.getByRole("link", { name: "Resume on the import screen" }).click();
      await page.getByRole("heading", { level: 1, name: "Import and export" }).waitFor();
      const waiting = page.getByRole("region", { name: "Imports waiting for their file" });
      await waiting.waitFor();
      expect(await waiting.textContent()).toContain(operationId);
      // Finish it, so that the next test finds no import in the way.
      await waiting.getByLabel("Or paste the text of the file").fill(text);
      await waiting.getByRole("button", { name: "Resume" }).click();
      await page.getByText("State of the import: succeeded").waitFor({ timeout: 60_000 });
    } finally {
      await session.close();
    }
  }, 240_000);

  it("an uncertain operation is never labelled failed: its badge, its panel and its timeline row all say uncertain", async () => {
    const name = newName();
    web.f.setFaults((point) => {
      if (point === "after_send") throw new Error("fault");
    });
    const answer = await web.f.create("env1a", name, valueOf());
    web.f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    const operationId = answer.operationId ?? "";
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await open(page, "operations");
      const row = rowWith(page, "Operations", operationId);
      await row.locator(".badge", { hasText: "uncertain" }).waitFor();
      expect(await row.textContent()).not.toMatch(/fail|reject/i);
      await row.getByRole("button", { name: "Details" }).click();
      const panel = page.getByRole("region", { name: "Operation details" });
      await panel.locator(".badge", { hasText: "uncertain" }).waitFor();
      const said = (await panel.textContent()) ?? "";
      expect(said).toContain(operationId);
      expect(said).toMatch(/Whether it happened is not known/);
      expect(said).toMatch(/An operator settles this from the host \(runbook reconciliation\.md\)/);
      expect(said).not.toMatch(/fail|reject/i);
      // Nothing here sends a change or settles anything.
      expect(await panel.getByRole("button").allTextContents()).toEqual(["Close"]);

      await open(page, "activity");
      const event = rowWith(page, "Activity", operationId);
      await event.locator(".badge", { hasText: "uncertain" }).waitFor();
      const line = (await event.textContent()) ?? "";
      expect(line).toContain("secret.create");
      expect(line).not.toMatch(/fail|reject|succe/i);
      expect(await event.getByRole("button").count()).toBe(0);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);
});

describe("the summary", () => {
  it('the summary shows "not measured" for the days before the first event and 0 for an empty later day', async () => {
    await auditRow("secret.create", "success", noon(3));
    await auditRow("secret.create", "success", noon(3));
    await auditRow("secret.update", "failure", noon(3));
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await open(page, "overview");
      const section = page.getByRole("region", { name: "Outcomes by day" });
      await section.waitFor();
      const rows = section.getByRole("table", { name: "Outcomes by day" }).locator("tbody tr");
      await rows.first().waitFor();
      const cells = async (day: string): Promise<string[]> =>
        rows
          .filter({ has: page.getByRole("rowheader", { name: day }) })
          .getByRole("cell")
          .allTextContents();
      expect(await rows.count()).toBe(7);
      for (const daysAgo of [6, 5, 4])
        expect(await cells(dayOf(daysAgo))).toEqual(["not measured"]);
      // Succeeded, failed, not known, denied, and all of them.
      expect(await cells(dayOf(3))).toEqual(["2", "1", "0", "0", "3"]);
      // A day with no event after the first one is a counted zero.
      expect(await cells(dayOf(2))).toEqual(["0", "0", "0", "0", "0"]);
      const said = (await section.textContent()) ?? "";
      expect(said).toMatch(/Source: the audit log/);
      expect(said).toMatch(/Window: /);
      expect(said).toMatch(/Observed /);
      expect(said).toMatch(/Nothing was measured before /);

      const unresolved = page.getByRole("region", { name: "Operations without an end" });
      const counted = await unresolved
        .getByRole("table", { name: "Operations without an end" })
        .locator("tbody tr")
        .getByRole("cell")
        .allTextContents();
      const direct = await web.api.superuser.query<{ unresolved: string; uncertain: string }>(
        `SELECT count(*) FILTER (WHERE state <> 'uncertain' OR completed_at IS NULL) AS unresolved,
                count(*) FILTER (WHERE state = 'uncertain') AS uncertain
           FROM app.operation
          WHERE organization_id = $1 AND parent_operation_id IS NULL
            AND state IN ('accepted', 'executing', 'awaiting_input', 'uncertain')`,
        [org()],
      );
      expect(counted).toEqual([direct.rows[0]?.unresolved, direct.rows[0]?.uncertain]);
    } finally {
      await session.close();
    }
  });
});

describe("who may read them", () => {
  it("as editorA the activity, audit and summary screens show the denial text, and the API answered 403", async () => {
    const session = await web.signedIn("editorA");
    const { page } = session;
    const refused: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 403) refused.push(new URL(response.url()).pathname);
    });
    try {
      for (const route of ["activity", "audit"] as const) {
        await open(page, route);
        const alert = page
          .getByRole("alert")
          .filter({ has: page.getByRole("heading", { name: "You may not do this here" }) });
        await alert.waitFor();
        expect(await alert.textContent()).toMatch(/Ask an owner or an admin/);
        expect(await page.getByRole("table").count()).toBe(0);
      }
      expect(refused).toEqual([
        `/v1/organizations/${org()}/activity`,
        `/v1/organizations/${org()}/audit`,
      ]);
      // The overview asks for no number a member may not have, and says who may.
      await open(page, "overview");
      await page
        .getByText(/shown to owners and admins of the organization/)
        .first()
        .waitFor();
      expect(await page.getByRole("region", { name: "Outcomes by day" }).count()).toBe(0);
      expect(await page.getByRole("region", { name: "Operations without an end" }).count()).toBe(0);
      expect(refused).toHaveLength(2);
      const direct = await web.f.send("GET", `/v1/organizations/${org()}/metrics`, {
        user: "editorA" satisfies FixtureUser,
        key: null,
      });
      expect(direct.status).toBe(403);
      expect(direct.code).toBe("action_denied");
    } finally {
      await session.close();
    }
  });
});

describe("the audit view", () => {
  it("the audit filters produce the request the form describes, and a reused cursor's listing_changed reloads from the start", async () => {
    for (let i = 0; i < 60; i += 1)
      await auditRow("secret.reveal", "success", new Date(Date.now() - 60_000 - i));
    await auditRow("access.denied", "denied", new Date(Date.now() - 30_000));
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await open(page, "audit");
      const table = page.getByRole("table", { name: "Audit events" });
      await table.locator("tbody tr").first().waitFor();
      expect(await table.locator("tbody tr").count()).toBe(50);

      // A second page asked with a cursor of other filters: the server says the listing changed.
      let bent = 0;
      const listing = new RegExp("/audit[?]");
      await page.route(listing, async (route) => {
        const url = new URL(route.request().url());
        if (!url.searchParams.has("cursor") || bent > 0) return route.fallback();
        bent += 1;
        url.searchParams.set("outcome", "denied");
        await route.continue({ url: url.toString() });
      });
      await page.getByRole("button", { name: "More" }).click();
      await page
        .getByText("The list changed while it was being read. It was read again from the start.")
        .waitFor();
      expect(bent).toBe(1);
      expect(await table.locator("tbody tr").count()).toBe(50);
      await page.unroute(listing);

      // The form's fields are the request's filters, and nothing else is sent.
      const from = dayOf(1);
      const to = dayOf(0);
      await page.getByLabel("From (UTC day)").fill(from);
      await page.getByLabel("To (UTC day)").fill(to);
      await page.getByLabel("Action", { exact: true }).fill("access.denied");
      await page.getByLabel("Outcome").selectOption("denied");
      await page.getByLabel("Actor kind").selectOption("user");
      await page.getByLabel("Actor id").fill(web.tenants.userId("ownerA"));
      const before = session.requested.length;
      await page.getByRole("button", { name: "Apply filters" }).click();
      await table.locator("tbody tr").first().waitFor();
      await page.getByText(/^1 event/).waitFor();
      const asked = apiPaths(session.requested.slice(before)).filter((path) =>
        path.startsWith(`/v1/organizations/${org()}/audit?`),
      );
      expect(asked).toHaveLength(1);
      expect(Object.fromEntries(new URL(asked[0] ?? "", web.origin).searchParams)).toEqual({
        limit: "50",
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
        action: "access.denied",
        outcome: "denied",
        actorKind: "user",
        actorId: web.tenants.userId("ownerA"),
      });
      const only = await table.locator("tbody tr").allTextContents();
      expect(only).toHaveLength(1);
      expect(only[0]).toContain("access.denied");

      // A filter the server refuses is the server's refusal, shown.
      await page.getByLabel("Action", { exact: true }).fill("not.an_action");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await page
        .getByRole("alert")
        .filter({ has: page.getByRole("heading", { name: "A value is not valid" }) })
        .waitFor();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await table.locator("tbody tr").first().waitFor();
      expect(await table.locator("tbody tr").count()).toBe(50);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);
});
