// Run 3.7 Task A (P-52): `decide` is Doc 04 §1.1 as a pure function. The first
// table is the matrix row by row, written from the document, not from the code.
import {
  ACTIONS,
  decide,
  type Action,
  type Authority,
  type Decision,
  type GrantRole,
  type Target,
} from "@mykey/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const E1A = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const E1B = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
const E2A = "2a2a2a2a-2a2a-42a2-82a2-2a2a2a2a2a2a";

const authority = (
  role: Authority["role"],
  projects: [string, GrantRole][] = [],
  environments: [string, string, GrantRole][] = [],
): Authority => ({
  role,
  projectGrants: new Map(projects),
  environmentGrants: new Map(
    environments.map(([id, projectId, r]) => [id, { projectId, role: r }]),
  ),
});

const OWNER = authority("owner");
const ADMIN = authority("admin");
const EDITOR = authority("member", [[P1, "editor"]]);
const READER = authority("member", [[P1, "reader"]]);
const UNGRANTED = authority("member");

const ENV: Target = { projectId: P1, environmentId: E1A };
const ORG: Target = {};

// Doc 04 §1.1, one row per line: action → [owner/admin, editor, reader, no grant].
// "Organization" and "Granted scope" are allow; "No" is denied where the caller
// can see the target and hidden where it cannot (no grant sees nothing in a project).
const MATRIX: readonly [string, Action, Target, Decision, Decision, Decision, Decision][] = [
  ["Manage projects/environments", "resources.manage", ENV, "allow", "denied", "denied", "hidden"],
  [
    "Manage projects (organization level)",
    "resources.manage",
    ORG,
    "allow",
    "denied",
    "denied",
    "denied",
  ],
  [
    "List names; read current values; export",
    "secrets.read",
    ENV,
    "allow",
    "allow",
    "allow",
    "hidden",
  ],
  ["Read history/historical values", "secrets.history", ENV, "allow", "allow", "allow", "hidden"],
  [
    "Create/update/delete/undelete/restore/import",
    "secrets.write",
    ENV,
    "allow",
    "allow",
    "denied",
    "hidden",
  ],
  [
    "Issue/list/revoke machine credentials",
    "credentials.manage",
    ENV,
    "allow",
    "denied",
    "denied",
    "hidden",
  ],
  ["View application audit", "audit.view", ORG, "allow", "denied", "denied", "denied"],
];

describe("Doc 04 §1.1, row by row", () => {
  for (const [row, action, target, owner, editor, reader, none] of MATRIX) {
    it(row, () => {
      expect(decide(OWNER, target, action)).toBe(owner);
      expect(decide(ADMIN, target, action)).toBe(owner);
      expect(decide(EDITOR, target, action)).toBe(editor);
      expect(decide(READER, target, action)).toBe(reader);
      expect(decide(UNGRANTED, target, action)).toBe(none);
    });
  }

  it("Provision organizations; reset accounts; restore service: no web role has it — no such action exists", () => {
    expect(ACTIONS).toEqual([
      "resources.manage",
      "secrets.read",
      "secrets.history",
      "secrets.write",
      "credentials.manage",
      "audit.view",
    ]);
  });
});

describe("visibility and the union of grants", () => {
  it("a member sees the organization (action null) and is denied every action there", () => {
    expect(decide(UNGRANTED, ORG, null)).toBe("allow");
    for (const action of ACTIONS) expect(decide(UNGRANTED, ORG, action)).toBe("denied");
  });

  it("a project grant covers every environment of the project", () => {
    expect(decide(READER, { projectId: P1, environmentId: E1B }, "secrets.read")).toBe("allow");
  });

  it("an environment grant makes its project visible, and only that environment", () => {
    const envEditor = authority("member", [], [[E1A, P1, "editor"]]);
    expect(decide(envEditor, { projectId: P1 }, null)).toBe("allow");
    expect(decide(envEditor, { projectId: P1 }, "resources.manage")).toBe("denied");
    expect(decide(envEditor, { projectId: P1, environmentId: E1A }, "secrets.write")).toBe("allow");
    expect(decide(envEditor, { projectId: P1, environmentId: E1B }, "secrets.read")).toBe("hidden");
    expect(decide(envEditor, { projectId: P2 }, null)).toBe("hidden");
    expect(decide(envEditor, { projectId: P2, environmentId: E2A }, null)).toBe("hidden");
  });

  it("grants combine by union: reader on the project, editor on one environment", () => {
    const mixed = authority("member", [[P1, "reader"]], [[E1A, P1, "editor"]]);
    expect(decide(mixed, { projectId: P1, environmentId: E1A }, "secrets.write")).toBe("allow");
    expect(decide(mixed, { projectId: P1, environmentId: E1B }, "secrets.write")).toBe("denied");
  });

  it("an environment grant cannot narrow a project grant", () => {
    const narrowed = authority("member", [[P1, "editor"]], [[E1A, P1, "reader"]]);
    expect(decide(narrowed, { projectId: P1, environmentId: E1A }, "secrets.write")).toBe("allow");
  });

  it("an environment target without its project is hidden", () => {
    expect(decide(OWNER, { environmentId: E1A }, null)).toBe("hidden");
  });
});

// ------------------------------------------------------------------ properties

const projects = [P1, P2];
const environments: [string, string][] = [
  [E1A, P1],
  [E1B, P1],
  [E2A, P2],
];
const grantRole = fc.constantFrom<GrantRole>("reader", "editor");
const projectGrant = fc.tuple(fc.constantFrom(...projects), grantRole);
const environmentGrant = fc.tuple(fc.constantFrom(...environments), grantRole);
const role = fc.constantFrom<Authority["role"]>("owner", "admin", "member");
const anyAuthority = fc
  .record({
    role,
    projects: fc.array(projectGrant, { maxLength: 3 }),
    environments: fc.array(environmentGrant, { maxLength: 4 }),
  })
  .map(({ role: r, projects: p, environments: e }) =>
    authority(
      r,
      p,
      e.map(([[id, projectId], g]) => [id, projectId, g]),
    ),
  );
const target = fc.oneof(
  fc.constant<Target>({}),
  fc.constantFrom(...projects).map((projectId): Target => ({ projectId })),
  fc.constantFrom(...environments).map(([environmentId, projectId]): Target => ({
    projectId,
    environmentId,
  })),
);
const action = fc.constantFrom<Action | null>(null, ...ACTIONS);
const RANK: Record<Decision, number> = { hidden: 0, denied: 1, allow: 2 };

function withGrant(
  base: Authority,
  grant: { project: [string, GrantRole] } | { environment: [[string, string], GrantRole] },
): Authority {
  const projectGrants = new Map(base.projectGrants);
  const environmentGrants = new Map(base.environmentGrants);
  if ("project" in grant) {
    const [id, r] = grant.project;
    if (projectGrants.get(id) !== "editor") projectGrants.set(id, r);
  } else {
    const [[id, projectId], r] = grant.environment;
    if (environmentGrants.get(id)?.role !== "editor")
      environmentGrants.set(id, { projectId, role: r });
  }
  return { role: base.role, projectGrants, environmentGrants };
}
const extraGrant = fc.oneof(
  projectGrant.map((project) => ({ project })),
  environmentGrant.map((environment) => ({ environment })),
);

describe("properties", () => {
  it("adding a grant never makes a decision weaker (allow stays allow)", () => {
    fc.assert(
      fc.property(anyAuthority, extraGrant, target, action, (base, grant, t, a) => {
        const before = decide(base, t, a);
        const after = decide(withGrant(base, grant), t, a);
        expect(RANK[after]).toBeGreaterThanOrEqual(RANK[before]);
      }),
      { numRuns: 2000 },
    );
  });

  it("an environment grant never narrows a project grant", () => {
    fc.assert(
      fc.property(
        grantRole,
        grantRole,
        fc.constantFrom(...environments),
        action,
        (projectRole, environmentRole, [environmentId, projectId], a) => {
          const projectOnly = authority("member", [[projectId, projectRole]]);
          const both = authority(
            "member",
            [[projectId, projectRole]],
            [[environmentId, projectId, environmentRole]],
          );
          for (const [id] of environments.filter(([, p]) => p === projectId)) {
            const t = { projectId, environmentId: id };
            expect(RANK[decide(both, t, a)]).toBeGreaterThanOrEqual(
              RANK[decide(projectOnly, t, a)],
            );
          }
        },
      ),
    );
  });

  it("no authority is always hidden", () => {
    fc.assert(
      fc.property(target, action, (t, a) => {
        expect(decide(null, t, a)).toBe("hidden");
      }),
    );
  });

  it("a member is never allowed resources.manage, credentials.manage or audit.view", () => {
    fc.assert(
      fc.property(
        anyAuthority.map((a) => ({ ...a, role: "member" as const })),
        target,
        fc.constantFrom<Action>("resources.manage", "credentials.manage", "audit.view"),
        (member, t, a) => {
          expect(decide(member, t, a)).not.toBe("allow");
        },
      ),
      { numRuns: 1000 },
    );
  });
});
