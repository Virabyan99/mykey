// The owner's journey through the workspace (Run 7.10): from the overview of
// a signed-in owner to a revoked token and the activity that records it. One
// browser page, real OpenBao, the real provisioning job. Every step asserts
// what the server then says, asked through the API as another admin, by the
// machine token, or read from the database: never what the page shows. The
// page is only driven and waited for.
//
// After the first address the page is never loaded again: every move is a
// link or a button, as an owner makes it. So whatever the page kept in memory
// is still there when canary.test.ts searches it.
//
// journey.test.ts runs it once with plain values; canary.test.ts runs it with
// canaries and then searches everything the browser kept.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { codeAt, stepAt } from "@mykey/auth";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { digestOf, machineCall, machinePath, resolveDigests } from "./machine.ts";
import type { StoresWeb } from "./web.ts";

export interface Entry {
  name: string;
  value: string;
}

export interface JourneyValues {
  project: string;
  environment: string;
  /** Three secrets: the first is edited and revealed, the second deleted and undeleted. */
  secrets: readonly [Entry, Entry, Entry];
  /** The first secret's second value. */
  edited: string;
  /** Two entries of the imported file. */
  imported: readonly [Entry, Entry];
  credential: string;
  /** The id of the user who makes the journey. */
  userId: string;
  /** A code for the step-up dialog, when the server asks for one. */
  code: () => Promise<string>;
}

export interface JourneyFacts {
  projectId: string;
  environmentId: string;
  /** The machine token the page showed once. It is revoked when the journey ends. */
  token: string;
}

/** Values of one journey; `value` makes each secret value. */
export function journeyValues(
  value: () => string,
  rest: Pick<JourneyValues, "userId" | "code">,
): JourneyValues {
  const tag = randomBytes(3).toString("hex");
  const name = (word: string): string => `JRN_${word}_${tag.toUpperCase()}`;
  return {
    project: `Journey ${tag}`,
    environment: `trip-${tag}`,
    secrets: [
      { name: name("ONE"), value: value() },
      { name: name("TWO"), value: value() },
      { name: name("THREE"), value: value() },
    ],
    edited: value(),
    imported: [
      { name: name("FOUR"), value: value() },
      { name: name("FIVE"), value: value() },
    ],
    credential: `journey-${tag}`,
    ...rest,
  };
}

/**
 * Codes of one authenticator. A code works once per step, so each call takes a
 * step that was not used yet, and `used` lists every code given out.
 */
export function authenticator(
  seed: Uint8Array,
  taken: Iterable<number> = [],
): { next: () => Promise<string>; used: string[] } {
  const steps = new Set(taken);
  const used: string[] = [];
  return {
    used,
    next: async () => {
      for (;;) {
        const now = stepAt(new Date());
        const step = [now, now + 1, now - 1].find((candidate) => !steps.has(candidate));
        if (step !== undefined) {
          steps.add(step);
          const code = codeAt(seed, step);
          used.push(code);
          return code;
        }
        await sleep(5_000);
      }
    },
  };
}

export const heading = (page: Page, name: string): Locator =>
  page.getByRole("heading", { level: 1, name });
const status = (page: Page, text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text });
const section = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true });

/** The sign-in form: password, then a code. Ends on the workspace. */
export async function signInByForm(
  page: Page,
  account: { email: string; password: string },
  code: () => Promise<string>,
): Promise<void> {
  await heading(page, "Sign in").waitFor();
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await heading(page, "Enter your code").waitFor();
  await page.getByLabel("Code from your authenticator app").fill(await code());
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("navigation", { name: "Scope" }).waitFor();
}

/** The Sign out button. Ends on the sign-in form. */
export async function signOutByButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await heading(page, "Sign in").waitFor();
}

async function confirmTyped(dialog: Locator, name: string, button: string): Promise<void> {
  await dialog.waitFor();
  await dialog.getByLabel("Type the name to confirm").fill(name);
  await dialog.getByRole("button", { name: button, exact: true }).click();
}

/** Waits for `done`; when the server asks for a fresh code first, gives one and does `again`. */
async function stepUpIfAsked(
  page: Page,
  values: JourneyValues,
  done: Locator,
  again: () => Promise<void>,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
  await done.or(dialog).first().waitFor({ timeout: 60_000 });
  if (!(await dialog.isVisible())) return;
  await dialog.getByLabel("Code from your authenticator app").fill(await values.code());
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await dialog.waitFor({ state: "hidden" });
  await again();
  await done.waitFor({ timeout: 60_000 });
}

const byName = ([a]: [string, string], [b]: [string, string]): number => (a < b ? -1 : 1);

/**
 * The journey, from the overview the signed-in owner is on. The provisioner
 * must be running (`web.f.fx.start()`).
 */
export async function ownerJourney(
  web: StoresWeb,
  page: Page,
  values: JourneyValues,
): Promise<JourneyFacts> {
  const org = web.tenants.a.organizationId;
  const db = web.api.superuser;
  /** The server's answer to another admin of the organization: a read that writes nothing. */
  const asAdmin = (path: string) => web.f.send("GET", path, { user: "adminA", key: null });
  const one = async (text: string, params: unknown[]): Promise<string> => {
    const result = await db.query<{ value: string }>(text, params);
    return result.rows[0]?.value ?? "";
  };
  /** Audit events of the journey's user with this action and a success. */
  const recorded = async (action: string): Promise<number> =>
    Number(
      await one(
        `SELECT count(*)::text AS value FROM audit.event
          WHERE organization_id = $1 AND actor_id = $2 AND action = $3 AND outcome = 'success'`,
        [org, values.userId, action],
      ),
    );

  // --- a project, and an environment in it -------------------------------
  await heading(page, "Overview").waitFor();
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill(values.project);
  await page.getByRole("button", { name: "Create project" }).click();
  const region = page.getByRole("region", { name: values.project });
  await region.waitFor();
  const projectId = await one(
    "SELECT id::text AS value FROM app.project WHERE organization_id = $1 AND name = $2",
    [org, values.project],
  );
  expect(projectId, "the server has the project").toMatch(/^[0-9a-f-]{36}$/);

  await region.getByRole("link", { name: values.project }).click();
  await heading(page, values.project).waitFor();
  await page.getByRole("button", { name: "New environment" }).click();
  await page.getByLabel("Environment name").fill(values.environment);
  await page.getByRole("button", { name: "Create environment" }).click();
  const made = page
    .getByRole("table", { name: "Environments" })
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name: values.environment, exact: true }) });
  await made.waitFor();
  const environmentId = await one(
    "SELECT id::text AS value FROM app.environment WHERE project_id = $1 AND name = $2",
    [projectId, values.environment],
  );
  expect(environmentId, "the server has the environment").toMatch(/^[0-9a-f-]{36}$/);
  // The real job makes the namespace's mount, policies and roles.
  await web.f.fx.waitFor(environmentId, "active", 180_000);
  const api = `/v1/organizations/${org}/projects/${projectId}/environments/${environmentId}`;

  const listed = async (): Promise<Map<string, { version: number | null; state: string }>> => {
    const answer = await asAdmin(`${api}/secrets?limit=100`);
    expect(answer.status, `secrets.list: ${answer.code ?? ""}`).toBe(200);
    const rows = answer.body.secrets as { name: string; version: number | null; state: string }[];
    return new Map(rows.map((row) => [row.name, { version: row.version, state: row.state }]));
  };

  // --- three secrets ------------------------------------------------------
  // The page learns by its own schedule that the environment is active.
  await made.getByText("active", { exact: false }).waitFor({ timeout: 60_000 });
  await made.getByRole("link", { name: values.environment, exact: true }).click();
  await heading(page, "Secrets").waitFor();
  for (const entry of values.secrets) {
    await page.getByRole("button", { name: "New secret" }).click();
    await page.getByLabel("Name", { exact: true }).fill(entry.name);
    await page.getByLabel("Value", { exact: true }).fill(entry.value);
    await page.getByRole("button", { name: "Create secret" }).click();
    await status(page, `${entry.name} is created at version 1`).waitFor({ timeout: 60_000 });
    expect((await listed()).get(entry.name)).toEqual({ version: 1, state: "live" });
  }
  expect(await recorded("secret.create")).toBe(3);

  // --- edit one, and reveal it --------------------------------------------
  const [first, second] = values.secrets;
  const secrets = page.getByRole("table", { name: "Secrets" });
  await secrets.getByRole("link", { name: first.name, exact: true }).click();
  await heading(page, first.name).waitFor();
  await page.getByRole("button", { name: "Edit value" }).click();
  await page.getByLabel("New value").fill(values.edited);
  await page.getByRole("button", { name: "Save" }).click();
  await status(page, "Saved as version 2").waitFor({ timeout: 60_000 });
  expect((await listed()).get(first.name)).toEqual({ version: 2, state: "live" });

  await page.getByRole("button", { name: "Reveal", exact: true }).click();
  const shown = page.getByLabel("Value", { exact: true });
  await shown.waitFor();
  expect(digestOf((await shown.textContent()) ?? "") === digestOf(values.edited)).toBe(true);
  expect(await recorded("secret.reveal"), "the reveal is in the audit log").toBe(1);

  // --- delete one, and bring it back --------------------------------------
  await section(page, "Secrets").click();
  await heading(page, "Secrets").waitFor();
  await secrets.getByRole("link", { name: second.name, exact: true }).click();
  await heading(page, second.name).waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmTyped(page.getByRole("dialog"), second.name, "Delete");
  await status(page, `${second.name} is deleted`).waitFor({ timeout: 60_000 });
  expect((await listed()).get(second.name)?.state).toBe("deleted");
  await page.getByRole("button", { name: "Undelete", exact: true }).click();
  await confirmTyped(page.getByRole("dialog"), second.name, "Undelete");
  await status(page, `${second.name} is live again at version 1`).waitFor({ timeout: 60_000 });
  expect((await listed()).get(second.name)).toEqual({ version: 1, state: "live" });

  // --- import a file ------------------------------------------------------
  await section(page, "Import and export").click();
  await heading(page, "Import and export").waitFor();
  const file = values.imported.map((entry) => `${entry.name}=${entry.value}\n`).join("");
  await page.getByLabel("Or paste the text of the file").fill(file);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByText("2 new").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Apply import" }).click();
  await page.getByText("State of the import: succeeded").waitFor({ timeout: 60_000 });
  const afterImport = await listed();
  expect(afterImport.size).toBe(5);
  for (const entry of values.imported) {
    expect(afterImport.get(entry.name)).toEqual({ version: 1, state: "live" });
  }

  // --- export -------------------------------------------------------------
  const askExport = async (): Promise<void> => {
    await page.getByRole("button", { name: "Export this environment" }).click();
    await confirmTyped(page.getByRole("dialog"), values.environment, "Export");
  };
  await askExport();
  await stepUpIfAsked(page, values, page.getByText(/The export is complete/), askExport);
  expect(await recorded("secret.export"), "the export is in the audit log").toBe(1);
  await page.getByRole("button", { name: "Discard" }).click();

  // --- a token: issued, used, revoked -------------------------------------
  await section(page, "Machine credentials").click();
  await heading(page, "Machine credentials").waitFor();
  await page.getByRole("button", { name: "New credential" }).click();
  await page.getByLabel("Name", { exact: true }).fill(values.credential);
  const issue = page.getByRole("button", { name: "Issue credential", exact: true });
  await issue.click();
  const panel = page.getByRole("region", { name: "The token, shown once" });
  await stepUpIfAsked(page, values, panel, () => issue.click());
  const token = (await panel.getByLabel("Token").textContent()) ?? "";

  const keysPath = machinePath(projectId, values.environment, "keys");
  const keys = await machineCall(web.f, "keys", { path: keysPath, token });
  expect(keys.status, `machine.keys: ${keys.code ?? ""}`).toBe(200);
  const resolved = await machineCall(web.f, "resolve", {
    path: machinePath(projectId, values.environment, "resolve"),
    token,
  });
  expect(resolved.status, `machine.resolve: ${resolved.code ?? ""}`).toBe(200);
  // What the store holds now, by digest: the edited value, and no older version.
  const expected: [string, string][] = [
    [first.name, digestOf(values.edited)],
    ...[...values.secrets.slice(1), ...values.imported].map((entry): [string, string] => [
      entry.name,
      digestOf(entry.value),
    ]),
  ];
  expect(resolveDigests(resolved).sort(byName)).toEqual(expected.sort(byName));

  const row = page
    .getByRole("table", { name: "Machine credentials" })
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name: values.credential, exact: true }) });
  await row.getByRole("button", { name: "Revoke" }).click();
  await confirmTyped(page.getByRole("dialog"), values.credential, "Revoke");
  await row.locator(".badge", { hasText: "revoked" }).waitFor({ timeout: 60_000 });
  const refused = await machineCall(web.f, "keys", { path: keysPath, token });
  expect(refused.status, "the revoked token is refused").toBe(401);

  // --- the activity records it --------------------------------------------
  await section(page, "Activity").click();
  await heading(page, "Activity").waitFor();
  await page.getByRole("table", { name: "Activity" }).locator("tbody tr").first().waitFor();
  const activity = await asAdmin(
    `/v1/organizations/${org}/activity?limit=100&projectId=${projectId}`,
  );
  expect(activity.status, `activity.list: ${activity.code ?? ""}`).toBe(200);
  const actions = new Set((activity.body.items as { action: string }[]).map((item) => item.action));
  for (const action of [
    "environment.create",
    "secret.create",
    "secret.update",
    "secret.reveal",
    "secret.delete",
    "secret.undelete",
    "import.apply",
    "secret.export",
    "credential.issue",
    "credential.revoke",
    "machine.keys",
    "machine.resolve",
  ]) {
    expect(actions.has(action), `the activity has ${action}`).toBe(true);
  }
  return { projectId, environmentId, token };
}
