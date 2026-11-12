import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { machineTokenRole, renderMachinePolicy, renderPolicy } from "@mykey/openbao";
import { describe, expect, it } from "vitest";

const PID = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5" as ProjectId;
const EID = "2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6" as EnvironmentId;

describe("policy templates", () => {
  it.each(["runtime", "issuer", "provisioner", "backup"] as const)(
    "the %s policy equals its committed snapshot",
    (kind) => {
      expect(renderPolicy(kind)).toMatchSnapshot();
    },
  );

  it("the machine policy equals its committed snapshot", () => {
    expect(renderMachinePolicy(PID, EID)).toMatchSnapshot();
  });

  it("the machine policy has exactly three path blocks and both ids, and no placeholder", () => {
    const text = renderMachinePolicy(PID, EID);
    expect(text.match(/^path "/gm)).toHaveLength(3);
    expect(text).toContain(`kv/data/p/${PID}/e/${EID}/*`);
    expect(text).toContain(`kv/metadata/p/${PID}/e/${EID}/`);
    expect(text).not.toContain("{{");
  });

  it("the machine policy refuses an id that is not a UUID", () => {
    expect(() => renderMachinePolicy("*" as ProjectId, EID)).toThrow("invalid project id");
    expect(() => renderMachinePolicy(PID, `${EID}/*` as EnvironmentId)).toThrow(
      "invalid environment id",
    );
  });

  it("no organization policy holds a delete or sudo capability", () => {
    for (const kind of ["runtime", "issuer", "provisioner", "backup"] as const) {
      expect(renderPolicy(kind), kind).not.toMatch(/"(delete|sudo)"/);
    }
  });

  it("the machine token role is a 30-day orphan service role without the default policy", () => {
    expect(machineTokenRole(EID)).toEqual({
      allowed_policies: [`machine-env-${EID}`],
      orphan: true,
      renewable: false,
      token_no_default_policy: true,
      token_explicit_max_ttl: 2592000,
      token_type: "service",
      token_period: 0,
      token_num_uses: 0,
    });
  });

  it("the machine token role refuses an id that is not a UUID", () => {
    expect(() => machineTokenRole("x" as EnvironmentId)).toThrow("invalid environment id");
  });
});
