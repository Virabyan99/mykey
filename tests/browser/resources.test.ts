// Run 7.3 (FR-1.89, FR-1.90, FR-1.17, P-139, P-140): the overview and the
// resource screens in Chromium, over both stores. A resource is shown in the
// state the server gave, never the one the page expects; an archive names
// what it revokes and needs the name typed; and the page stays far below its
// own request limits (Review focus 5).
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAt, newProject, type Place } from "../harness/lifecycle-fixture.ts";
import { startWebWithStores, type StoresWeb, type WebSession } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

const org = (): string => web.tenants.a.organizationId;
const overviewPath = (): string => webPath("overview", { org: org() });
const projectPath = (project: string): string => webPath("project", { org: org(), project });
const tag = (): string => randomBytes(3).toString("hex");

const apiCalls = (session: WebSession): string[] =>
  session.requested.map((url) => new URL(url).pathname).filter((path) => path.startsWith("/v1/"));

async function one<T extends Record<string, unknown>>(text: string, values: unknown[]): Promise<T> {
  const rows = await web.api.superuser.query<T>(text, values);
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`no row: ${text}`);
  return row;
}
const projectByName = (name: string) =>
  one<{ id: string; state: string }>(
    "SELECT id, state FROM app.project WHERE organization_id = $1 AND name = $2",
    [org(), name],
  );
const environmentById = (id: string) =>
  one<{ name: string; state: string }>("SELECT name, state FROM app.environment WHERE id = $1", [
    id,
  ]);
const environmentByName = (projectId: string, name: string) =>
  one<{ id: string; state: string }>(
    "SELECT id, state FROM app.environment WHERE project_id = $1 AND name = $2",
    [projectId, name],
  );

/** A project made past the product, with one active environment, and both names. */
async function place(): Promise<Place & { projectName: string; environmentName: string }> {
  const made = await newProject(web.f);
  const project = await one<{ name: string }>("SELECT name FROM app.project WHERE id = $1", [
    made.projectId,
  ]);
  const environment = await environmentById(made.environmentId);
  return { ...made, projectName: project.name, environmentName: environment.name };
}

const environments = (page: Page): Locator => page.getByRole("table", { name: "Environments" });
/** The row whose name cell is exactly this name (a row's whole text also holds its id). */
const rowOf = (page: Page, name: string): Locator =>
  environments(page)
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name, exact: true }) });

async function openProject(page: Page, projectId: string, name: string): Promise<void> {
  await page.goto(`${web.origin}${projectPath(projectId)}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await environments(page).waitFor();
}

/** The confirmation with the typed name: the button works only when the name is exact. */
async function confirmTyped(dialog: Locator, name: string, button: string): Promise<void> {
  const confirm = dialog.getByRole("button", { name: button, exact: true });
  const typed = dialog.getByLabel("Type the name to confirm");
  expect(await confirm.isDisabled()).toBe(true);
  await typed.fill(`${name}x`);
  expect(await confirm.isDisabled()).toBe(true);
  await typed.fill(name);
  expect(await confirm.isDisabled()).toBe(false);
  await confirm.click();
}

describe("the overview and the resource screens", () => {
  // First in the file: nothing is pending yet, so nothing has a reason to be asked again.
  it("one overview load makes at most 5 API requests, and an idle minute makes none", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.clock.install();
      await page.goto(`${web.origin}${overviewPath()}`);
      const first = page.getByRole("region", { name: "Project One" });
      await first.waitFor();
      await page.waitForLoadState("networkidle");
      // The counts are the index's, and the page says so and when.
      expect(await page.getByRole("main").textContent()).toMatch(
        /Key counts come from the index, as of /,
      );
      expect(await first.locator("tbody tr").count()).toBe(2);

      const load = apiCalls(session);
      expect(load.length, load.join(" ")).toBeLessThanOrEqual(6);
      expect(load).toContain(`/v1/organizations/${org()}/overview`);
      expect(load).toContain(`/v1/organizations/${org()}/credentials/summary`);
      expect(load).toContain(`/v1/organizations/${org()}/metrics`);

      await page.clock.fastForward(60_000);
      await sleep(1000);
      await page.waitForLoadState("networkidle");
      expect(apiCalls(session)).toEqual(load);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("create a project, then an environment: the environment is shown pending until the server says active, never before", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const projectName = `Created ${tag()}`;
    const environmentName = `stage-${tag()}`;
    let provisioner: Awaited<ReturnType<typeof web.f.fx.start>> | null = null;
    try {
      await page.goto(`${web.origin}${overviewPath()}`);
      await page.getByRole("button", { name: "New project" }).click();
      await page.getByLabel("Project name").fill(projectName);
      await page.getByRole("button", { name: "Create project" }).click();
      const region = page.getByRole("region", { name: projectName });
      await region.waitFor();
      const project = await projectByName(projectName);
      // No provisioner runs: the server says pending, and so does the page.
      expect(project.state).toBe("pending");
      expect(await region.getByRole("heading", { level: 2 }).textContent()).toContain("pending");

      await region.getByRole("link", { name: projectName }).click();
      await page.waitForURL(`${web.origin}${projectPath(project.id)}`);
      await page.getByRole("heading", { level: 1, name: projectName }).waitFor();
      await page.getByRole("button", { name: "New environment" }).click();
      await page.getByLabel("Environment name").fill(environmentName);
      await page.getByRole("button", { name: "Create environment" }).click();
      const row = rowOf(page, environmentName);
      await row.waitFor();
      const environment = await environmentByName(project.id, environmentName);
      expect(environment.state).toBe("pending");
      expect(await row.textContent()).toContain("pending");

      // The page asks again by its schedule; while the server says pending, so does the row.
      const asked = apiCalls(session).length;
      await sleep(4000);
      expect(apiCalls(session).length).toBeGreaterThan(asked);
      expect((await environmentById(environment.id)).state).toBe("pending");
      expect(await row.textContent()).toContain("pending");
      expect(await row.textContent()).not.toContain("active");

      // The real job runs: the server says active, and then the page does, without a reload.
      provisioner = await web.f.fx.start();
      await web.f.fx.waitFor(environment.id, "active", 120_000);
      await row.getByText("active", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await row.textContent()).not.toContain("pending");
      expect(await session.violations()).toEqual([]);
    } finally {
      await provisioner?.stop();
      await session.close();
    }
  }, 240_000);

  it("rename a project and an environment: the page shows the server's new names", async () => {
    const made = await place();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const projectName = `Renamed ${tag()}`;
    const environmentName = `renamed-${tag()}`;
    try {
      await openProject(page, made.projectId, made.projectName);
      await page.getByRole("button", { name: "Rename project" }).click();
      await page.getByLabel("New name").fill(projectName);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: projectName }).waitFor();
      expect((await projectByName(projectName)).id).toBe(made.projectId);
      // The scope bar reads the same list.
      await page
        .getByRole("navigation", { name: "Scope" })
        .getByLabel("Project", { exact: true })
        .locator("option:checked", { hasText: projectName })
        .waitFor({ state: "attached" });

      await rowOf(page, made.environmentName).getByRole("button", { name: "Rename" }).click();
      await page.getByLabel("New name").fill(environmentName);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await rowOf(page, environmentName).waitFor();
      expect((await environmentById(made.environmentId)).name).toBe(environmentName);
      expect(await rowOf(page, made.environmentName).count()).toBe(0);

      // A name that breaks the rule is refused with the rule's own words, and nothing changes.
      await rowOf(page, environmentName).getByRole("button", { name: "Rename" }).click();
      await page.getByLabel("New name").fill("Not A Valid Name");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: /lower-case letters, digits and hyphens/ })
        .waitFor();
      expect((await environmentById(made.environmentId)).name).toBe(environmentName);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("archive asks for the typed name and lists one active credential; after it the environment is archived, its secrets screen offers no write, and reactivate brings it back", async () => {
    const made = await place();
    const issued = await issueAt(web.f, made);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const credentialState = async (): Promise<string> =>
      (
        await one<{ state: string }>("SELECT state FROM app.machine_credential WHERE id = $1", [
          issued.credentialId,
        ])
      ).state;
    try {
      await openProject(page, made.projectId, made.projectName);
      const row = rowOf(page, made.environmentName);
      await row.getByRole("button", { name: "Archive" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("heading", { name: `Archive the environment ${made.environmentName}` })
        .waitFor();
      await dialog.getByText("Active machine credentials that will be revoked: 1").waitFor();
      await dialog.getByText("Issuances not finished: 0").waitFor();
      expect(await credentialState()).toBe("active");
      await confirmTyped(dialog, made.environmentName, "Archive");

      await row.getByText("archived").waitFor({ timeout: 30_000 });
      expect((await environmentById(made.environmentId)).state).toBe("archived");
      expect(await credentialState()).toBe("revoked");
      await page.getByRole("status").filter({ hasText: "1 credential revoked" }).waitFor();
      // An archived environment offers reactivation and nothing else.
      expect(await row.getByRole("button").allTextContents()).toEqual(["Reactivate"]);

      // Its secrets screen says so, and has nothing to write with.
      await row.getByRole("link", { name: made.environmentName }).click();
      await page.waitForURL(
        `${web.origin}${webPath("secrets", { org: org(), project: made.projectId, env: made.environmentId })}`,
      );
      await page.getByText(/This environment is archived/).waitFor();
      await page.getByText(/Nothing can be written/).waitFor();
      expect(
        await page
          .getByRole("main")
          .getByRole("button", { name: /new|create|add|save|import/i })
          .count(),
      ).toBe(0);

      await page.goBack();
      await rowOf(page, made.environmentName).getByRole("button", { name: "Reactivate" }).click();
      const again = page.getByRole("dialog");
      await again
        .getByRole("heading", { name: `Reactivate the environment ${made.environmentName}` })
        .waitFor();
      // Reactivation does not bring a credential back, and the dialog says so.
      await again.getByText(/revoked credentials stay revoked/).waitFor();
      await confirmTyped(again, made.environmentName, "Reactivate");
      await rowOf(page, made.environmentName).getByText("active").waitFor({ timeout: 30_000 });
      expect((await environmentById(made.environmentId)).state).toBe("active");
      expect(await credentialState()).toBe("revoked");
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a needs_review project shows its reason and no create button", async () => {
    const made = await place();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      // The control: an active project offers what a project under review must not.
      await openProject(page, made.projectId, made.projectName);
      await page.getByRole("button", { name: "New environment" }).waitFor();

      await web.api.superuser.query(
        "UPDATE app.project SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
        [made.projectId],
      );
      await page.reload();
      await page.getByRole("heading", { level: 1, name: made.projectName }).waitFor();
      const main = page.getByRole("main");
      await main.getByText("needs review").first().waitFor();
      await main.getByText("backend_inconsistent").waitFor();
      await main.getByText(/An operator settles this/).waitFor();
      for (const name of ["New environment", "Rename project", "Archive project"]) {
        expect(await page.getByRole("button", { name }).count(), name).toBe(0);
      }
      // The ids are the server's and do not change with a name (FR-1.90).
      expect(await main.textContent()).toContain(made.projectId);
      expect(await rowOf(page, made.environmentName).textContent()).toContain(made.environmentId);

      // An environment the server is closing offers nothing either (AC-1.46).
      await web.api.superuser.query("UPDATE app.environment SET state = 'revoking' WHERE id = $1", [
        made.environmentId,
      ]);
      await web.api.superuser.query(
        "UPDATE app.project SET state = 'active', review_reason = NULL WHERE id = $1",
        [made.projectId],
      );
      await page.reload();
      await rowOf(page, made.environmentName).getByText("revoking").waitFor();
      expect(await rowOf(page, made.environmentName).getByRole("button").count()).toBe(0);
      await web.api.superuser.query("UPDATE app.environment SET state = 'active' WHERE id = $1", [
        made.environmentId,
      ]);
      await web.api.superuser.query(
        "UPDATE app.project SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
        [made.projectId],
      );

      // On the overview too: the state and the reason, and the counts of its environment stay.
      await page.goto(`${web.origin}${overviewPath()}`);
      const region = page.getByRole("region", { name: made.projectName });
      await region.waitFor();
      expect(await region.textContent()).toContain("needs review");
      expect(await region.textContent()).toContain("backend_inconsistent");
      expect(await session.violations()).toEqual([]);
    } finally {
      await web.api.superuser.query("UPDATE app.environment SET state = 'active' WHERE id = $1", [
        made.environmentId,
      ]);
      await web.api.superuser.query(
        "UPDATE app.project SET state = 'active', review_reason = NULL WHERE id = $1",
        [made.projectId],
      );
      await session.close();
    }
  }, 240_000);
});
