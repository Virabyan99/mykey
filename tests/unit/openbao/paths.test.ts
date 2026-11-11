import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";
import {
  environmentPrefix,
  isEnvironmentPrefix,
  isMachineName,
  isOrganizationNamespace,
  isSecretPath,
  machineName,
  namespaceFor,
  secretPath,
} from "@mykey/openbao";
import { describe, expect, it } from "vitest";

const ORG = "0b9a3c1e-5f6d-4e7a-8b9c-0d1e2f3a4b5c" as OrganizationId;
const PID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5" as ProjectId;
const EID = "2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6" as EnvironmentId;

function thrownText(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

describe("backend paths", () => {
  it("namespaceFor of a known UUID is org-<uuid>", () => {
    expect(namespaceFor(ORG)).toBe(`org-${ORG}`);
  });

  it("environmentPrefix and secretPath build p/<pid>/e/<eid>/NAME", () => {
    expect(environmentPrefix(PID, EID)).toBe(`p/${PID}/e/${EID}/`);
    expect(secretPath(PID, EID, "DATABASE_URL")).toBe(`p/${PID}/e/${EID}/DATABASE_URL`);
  });

  it("machineName is machine-env-<eid>", () => {
    expect(machineName(EID)).toBe(`machine-env-${EID}`);
  });

  it.each(["A/B", "../A", "A..B", "..", "lower", "Mixed", "SECRETS_X", "", "A B"])(
    "secretPath refuses the name %j without echoing it",
    (name) => {
      const text = thrownText(() => secretPath(PID, EID, name));
      expect(text).toMatch(/^invalid secret name/);
      if (name !== "") expect(text).not.toContain(name);
    },
  );

  // Upper case is refused too: one id has exactly one backend path.
  const badIds = ["not-a-uuid", "../sys", `${PID}/x`, "", PID.replace(/-/g, ""), PID.toUpperCase()];

  it.each(badIds)("refuses the id %j in every builder without echoing it", (bad) => {
    const cases: [string, () => unknown][] = [
      ["organization", () => namespaceFor(bad as OrganizationId)],
      ["project", () => environmentPrefix(bad as ProjectId, EID)],
      ["environment", () => environmentPrefix(PID, bad as EnvironmentId)],
      ["project", () => secretPath(bad as ProjectId, EID, "A")],
      ["environment", () => secretPath(PID, bad as EnvironmentId, "A")],
      ["environment", () => machineName(bad as EnvironmentId)],
    ];
    for (const [kind, action] of cases) {
      const text = thrownText(action);
      expect(text).toBe(`invalid ${kind} id`);
      if (bad !== "") expect(text).not.toContain(bad);
    }
  });

  it("the validators accept exactly what the builders produce", () => {
    expect(isOrganizationNamespace(namespaceFor(ORG))).toBe(true);
    expect(isEnvironmentPrefix(environmentPrefix(PID, EID))).toBe(true);
    expect(isSecretPath(secretPath(PID, EID, "A_1"))).toBe(true);
    expect(isMachineName(machineName(EID))).toBe(true);

    for (const value of ["", "org-", `org-${ORG}/`, `org-${ORG}/x`, ORG, "root", `t-${ORG}`]) {
      expect(isOrganizationNamespace(value), value).toBe(false);
    }
    for (const value of [
      `p/${PID}/e/${EID}`,
      `p/${PID}/e/${EID}/A`,
      `p/${PID}/e/`,
      `p/${PID}/e/${EID}//`,
      `/p/${PID}/e/${EID}/`,
      `p/x/e/${EID}/`,
    ]) {
      expect(isEnvironmentPrefix(value), value).toBe(false);
    }
    for (const value of [
      `p/${PID}/e/${EID}/`,
      `p/${PID}/e/${EID}/a`,
      `p/${PID}/e/${EID}/A/B`,
      `p/${PID}/e/${EID}/../A`,
      `p/${PID}/e/${EID}/SECRETS_A`,
      `p/${PID}/e/${EID}/A?version=1`,
      `p/${PID}/e/not-a-uuid/A`,
      `../p/${PID}/e/${EID}/A`,
    ]) {
      expect(isSecretPath(value), value).toBe(false);
    }
    for (const value of ["machine-env-", `machine-env-${EID}/x`, "runtime", `machine-env-x`]) {
      expect(isMachineName(value), value).toBe(false);
    }
  });
});
