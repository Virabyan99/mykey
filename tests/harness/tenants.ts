// Two organizations and seven users for the authorization tests (Run 3.7).
// Inserted through the superuser: no product path creates members, grants,
// projects or environments in Session 3 — that is the specification, not a
// shortcut. Every user is enrolled through the HTTP routes, so `cookie()`
// returns a real `mfa_complete` session with a fresh TOTP verification.
import { randomBytes, randomUUID } from "node:crypto";
import { enrollOwner, type TestApi } from "./api.ts";

export type FixtureUser =
  "ownerA" | "adminA" | "editorA" | "readerA" | "envEditorA" | "ungrantedA" | "ownerB";

export const FIXTURE_USERS: readonly FixtureUser[] = [
  "ownerA",
  "adminA",
  "editorA",
  "readerA",
  "envEditorA",
  "ungrantedA",
  "ownerB",
];

export interface Tenants {
  a: {
    organizationId: string;
    project1: string;
    env1a: string;
    env1b: string;
    project2: string;
    env2a: string;
  };
  b: { organizationId: string; project1: string; env1a: string };
  cookie(user: FixtureUser): Promise<string>;
  userId(user: FixtureUser): string;
  /** E-mail, password and TOTP seed, for a new sign-in. */
  credentials(user: FixtureUser): { email: string; password: string; seed: Uint8Array };
}

const MEMBERSHIP: Record<FixtureUser, { org: "a" | "b"; role: "owner" | "admin" | "member" }> = {
  ownerA: { org: "a", role: "owner" },
  adminA: { org: "a", role: "admin" },
  editorA: { org: "a", role: "member" },
  readerA: { org: "a", role: "member" },
  envEditorA: { org: "a", role: "member" },
  ungrantedA: { org: "a", role: "member" },
  ownerB: { org: "b", role: "owner" },
};

export async function createTenants(api: TestApi): Promise<Tenants> {
  const db = api.superuser;
  const a = {
    organizationId: randomUUID(),
    project1: randomUUID(),
    env1a: randomUUID(),
    env1b: randomUUID(),
    project2: randomUUID(),
    env2a: randomUUID(),
  };
  const b = { organizationId: randomUUID(), project1: randomUUID(), env1a: randomUUID() };

  for (const organizationId of [a.organizationId, b.organizationId]) {
    await db.query(
      "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')",
      [organizationId, `org-${organizationId}`],
    );
  }
  const projects: [string, string, string][] = [
    [a.organizationId, a.project1, "Project One"],
    [a.organizationId, a.project2, "Project Two"],
    [b.organizationId, b.project1, "Project One"],
  ];
  for (const [organizationId, id, name] of projects) {
    await db.query(
      "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'active')",
      [id, organizationId, name],
    );
  }
  const environments: [string, string, string, string][] = [
    [a.organizationId, a.project1, a.env1a, "dev"],
    [a.organizationId, a.project1, a.env1b, "prod"],
    [a.organizationId, a.project2, a.env2a, "dev"],
    [b.organizationId, b.project1, b.env1a, "dev"],
  ];
  for (const [organizationId, projectId, id, name] of environments) {
    await db.query(
      `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
       VALUES ($1, $2, $3, $4, 'active', true)`,
      [id, organizationId, projectId, name],
    );
  }

  const hasher = (await api.auth.$context).password;
  const users = new Map<
    FixtureUser,
    { id: string; email: string; password: string; seed: Uint8Array; cookie: string }
  >();
  const tag = randomBytes(3).toString("hex");
  for (const name of FIXTURE_USERS) {
    const id = randomUUID();
    const email = `${name.toLowerCase()}-${tag}@mykey.invalid`;
    const password = randomBytes(18).toString("base64url");
    await db.query(
      `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, name, email],
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
    const { org, role } = MEMBERSHIP[name];
    await db.query(
      `INSERT INTO app.membership (id, organization_id, user_id, role, state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'active')`,
      [org === "a" ? a.organizationId : b.organizationId, id, role],
    );
    const enrolled = await enrollOwner(api, {
      userId: id,
      organizationId: org === "a" ? a.organizationId : b.organizationId,
      email,
      password,
    });
    users.set(name, { id, email, password, seed: enrolled.seed, cookie: enrolled.cookie });
    // Seven sign-ins from one address would trip the per-source limit (Run 3.3).
    await db.query("DELETE FROM app.rate_limit");
  }

  const userOf = (name: FixtureUser) => {
    const found = users.get(name);
    if (found === undefined) throw new Error(`no fixture user ${name}`);
    return found;
  };
  const grant = async (
    user: FixtureUser,
    role: "reader" | "editor",
    target: { projectId: string } | { environmentId: string },
  ) => {
    await db.query(
      `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, environment_id, role)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [
        a.organizationId,
        userOf(user).id,
        "projectId" in target ? target.projectId : null,
        "environmentId" in target ? target.environmentId : null,
        role,
      ],
    );
  };
  await grant("editorA", "editor", { projectId: a.project1 });
  await grant("readerA", "reader", { projectId: a.project1 });
  await grant("envEditorA", "editor", { environmentId: a.env1a });

  return {
    a,
    b,
    cookie: (name) => Promise.resolve(userOf(name).cookie),
    userId: (name) => userOf(name).id,
    credentials: (name) => {
      const { email, password, seed } = userOf(name);
      return { email, password, seed };
    },
  };
}

/**
 * Makes `organizationId` active and gives it one active project with one ready
 * environment (through the superuser), for suites whose owner comes from
 * `seedOwner` and who need a target their routes can reach (Run 3.7).
 */
export async function activeTarget(
  api: TestApi,
  organizationId: string,
): Promise<{ org: string; project: string; env: string }> {
  const project = randomUUID();
  const env = randomUUID();
  await api.superuser.query("UPDATE app.organization SET state = 'active' WHERE id = $1", [
    organizationId,
  ]);
  await api.superuser.query(
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, 'Target', 'active')",
    [project, organizationId],
  );
  await api.superuser.query(
    `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
     VALUES ($1, $2, $3, 'dev', 'active', true)`,
    [env, organizationId, project],
  );
  return { org: organizationId, project, env };
}
