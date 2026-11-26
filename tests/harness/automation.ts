// Session 11 (Run 11.5, D-82): what the automation tests share. An automation
// credential's secret (`mkac.<id>.<secret>`) is a local of the test that asked
// for it: nothing here prints it, and a failing assertion on it shows shapes,
// lengths and booleans only (Doc 10 §4.1 rule 2).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { expect } from "vitest";
import type { CredentialsFixture } from "./credentials-fixture.ts";
import { machineFetch, type MachineAnswer, type MachineRequest } from "./machine.ts";
import type { Answer, SecretsFixture } from "./secrets-fixture.ts";
import type { FixtureUser } from "./tenants.ts";

/** The networks the fixture's own requests come from. */
export const LOOPBACK: readonly string[] = ["127.0.0.0/8"];

export const automationPath = (f: CredentialsFixture): string =>
  `/v1/organizations/${f.tenants.a.organizationId}/automation-credentials`;

interface Init {
  user?: FixtureUser;
  key?: string;
  fresh?: boolean;
}

/** POST automation-credentials with a fresh session and a new key, unless the test says otherwise. */
export async function issueAutomation(
  f: CredentialsFixture,
  body: Record<string, unknown> = {},
  init: Init = {},
): Promise<Answer> {
  if (init.fresh !== false) await f.freshen();
  return f.send("POST", automationPath(f), {
    body: { name: "provisioner", rights: ["projects.create"], cidrs: LOOPBACK, ...body },
    key: init.key ?? randomUUID(),
    ...(init.user === undefined ? {} : { user: init.user }),
  });
}

export interface IssuedAutomation {
  credentialId: string;
  ownerId: string;
  /** The presented secret: a local of the caller. */
  secret: string;
  operationId: string;
  requestId: string;
}

/** Issues one automation credential through the route; fails unless 201. */
export async function issueAutomationFor(
  f: CredentialsFixture,
  body: Record<string, unknown> = {},
): Promise<IssuedAutomation> {
  const answer = await issueAutomation(f, body);
  expect(answer.status, `issue automation: ${answer.code ?? ""}`).toBe(201);
  const credential = answer.body.credential as { credentialId: string; ownerId: string };
  return {
    credentialId: credential.credentialId,
    ownerId: credential.ownerId,
    secret: answer.body.secret as string,
    operationId: answer.body.operationId as string,
    requestId: answer.headers.get("x-request-id") ?? "",
  };
}

export function revokeAutomation(
  f: CredentialsFixture,
  credentialId: string,
  init: { user?: FixtureUser; key?: string; body?: unknown } = {},
): Promise<Answer> {
  return f.send("POST", `${automationPath(f)}/${credentialId}/revoke`, {
    body: init.body ?? { confirmed: true },
    key: init.key ?? randomUUID(),
    ...(init.user === undefined ? {} : { user: init.user }),
  });
}

/** The owner's list, as the views of the first page (the newest first). */
export async function listAutomation(
  f: CredentialsFixture,
  init: { user?: FixtureUser; query?: string } = {},
): Promise<Answer> {
  return f.send("GET", `${automationPath(f)}${init.query ?? ""}`, {
    key: null,
    ...(init.user === undefined ? {} : { user: init.user }),
  });
}

/** Removes every automation credential of the fixture's organizations, and what names one. */
export async function clearAutomation(f: CredentialsFixture): Promise<void> {
  await f.api.superuser.query("UPDATE app.project SET managed_by = NULL");
  await f.api.superuser.query("DELETE FROM app.automation_credential");
}

/** The ten routes of the automation class, in the contract's order. */
export const AUTOMATION_ROUTES: readonly RouteDef[] = ROUTES.filter(
  (route) => route.auth === "automation",
);

export const automationRoute = (id: string): RouteDef => {
  const found = AUTOMATION_ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no automation route ${id}`);
  return found;
};

/** A well-formed body for each automation mutation; a name is new on every call. */
export function automationBody(id: string): unknown {
  switch (id) {
    case "automation.projects.create":
      return { name: `Tenant ${randomUUID().slice(0, 8)}` };
    case "automation.environments.create":
      return { name: `e${randomUUID().slice(0, 8)}` };
    case "automation.secrets.create":
      return { name: `AUTO_${randomUUID().slice(0, 8).toUpperCase()}`, value: "synthetic" };
    case "automation.runtime_credentials.issue":
      return { name: "server" };
    case "automation.runtime_credentials.revoke":
      return { confirmed: true };
    default:
      return undefined;
  }
}

export interface AutomationIds {
  project?: string;
  env?: string;
  credential?: string;
  operation?: string;
}

/** The route's path with these ids; a parameter not given is a random UUID. */
export function automationPathOf(route: RouteDef, ids: AutomationIds = {}): string {
  return route.path.replace(
    /:([A-Za-z]+)/g,
    (_match, name: string) => (ids as Record<string, string | undefined>)[name] ?? randomUUID(),
  );
}

/**
 * One request of an automation route to the fixture's first API: raw HTTPS,
 * no cookie, no Origin. `secret` is the bearer (`mkac.<id>.<secret>`), a local
 * of the caller that nothing here prints. A mutation gets a new
 * Idempotency-Key and its well-formed body unless the caller says otherwise
 * (`key: null` sends none).
 */
export function automationCall(
  f: SecretsFixture,
  id: string,
  init: {
    secret?: string;
    ids?: AutomationIds;
    body?: unknown;
    key?: string | null;
    query?: string;
    headers?: MachineRequest["headers"];
    /** A path as sent, instead of the route's with `ids`. */
    path?: string;
  } = {},
): Promise<MachineAnswer> {
  const route = automationRoute(id);
  const ca = readFileSync(f.stack.api.certAuthorityPath);
  const body = init.body === undefined ? automationBody(id) : init.body;
  const key = init.key === undefined ? (route.idempotent ? randomUUID() : null) : init.key;
  return machineFetch(
    { port: f.api.port, ca },
    route.method,
    init.path ?? automationPathOf(route, init.ids),
    {
      ...(init.secret === undefined ? {} : { token: init.secret }),
      headers: { ...(key === null ? {} : { "idempotency-key": key }), ...init.headers },
      ...(route.method === "GET" || body === undefined
        ? {}
        : { body: { text: JSON.stringify(body) } }),
      ...(init.query === undefined ? {} : { query: init.query }),
    },
  );
}

/** A secret of the right shape that names no credential. */
export const strangerSecret = (prefix: string, bytes: Buffer): string =>
  `${prefix}.${randomUUID()}.${bytes.toString("base64url")}`;

/** The `access.denied` rows of one credential since `since`: route id and reason, oldest first. */
export async function automationDenials(
  f: SecretsFixture,
  credentialId: string,
  since: Date,
): Promise<{ routeId: string; reason: string; targetKind: string | null }[]> {
  const rows = await f.api.superuser.query<{
    details: { routeId: string; reason: string };
    target_kind: string | null;
  }>(
    `SELECT details, target_kind FROM audit.event
      WHERE action = 'access.denied' AND actor_kind = 'machine' AND actor_id = $1
        AND occurred_at >= $2
      ORDER BY occurred_at, id`,
    [credentialId, since],
  );
  return rows.rows.map((row) => ({
    routeId: row.details.routeId,
    reason: row.details.reason,
    targetKind: row.target_kind,
  }));
}
