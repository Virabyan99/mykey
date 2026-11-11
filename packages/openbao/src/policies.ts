// OpenBao policy text and machine token roles. The policy text lives in
// infra/openbao/policies/*.hcl; this module reads it and substitutes only ids
// that paths.ts has validated.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS, type EnvironmentId, type ProjectId } from "@mykey/contracts";
import { environmentPrefix, machineName } from "./paths.ts";

const POLICY_DIRECTORY = resolve(import.meta.dirname, "../../../infra/openbao/policies");

export type PolicyKind = "runtime" | "issuer" | "provisioner" | "backup";
export type AppRoleName = "runtime" | "issuer" | "provisioner";

/** Token TTL of each AppRole (P-22): `token_ttl` = `token_max_ttl`. */
export const APPROLE_TOKEN_TTL_SECONDS: Readonly<Record<AppRoleName, number>> = Object.freeze({
  runtime: 900,
  issuer: LIMITS.machineToken.issuerSessionSeconds,
  provisioner: 300,
});

function template(file: string): string {
  return readFileSync(join(POLICY_DIRECTORY, file), "utf8");
}

export function renderPolicy(kind: PolicyKind): string {
  return template(`${kind}.hcl`);
}

export function renderMachinePolicy(projectId: ProjectId, environmentId: EnvironmentId): string {
  // environmentPrefix validates both ids; nothing else is substituted.
  environmentPrefix(projectId, environmentId);
  return template("machine-env.hcl")
    .replaceAll("{{pid}}", projectId)
    .replaceAll("{{eid}}", environmentId);
}

export interface MachineTokenRole {
  allowed_policies: string[];
  orphan: true;
  renewable: false;
  token_no_default_policy: true;
  token_explicit_max_ttl: number;
  token_type: "service";
  token_period: 0;
  token_num_uses: 0;
}

/** The token role `machine-env-<eid>`: 30-day orphan service tokens with only the machine policy. */
export function machineTokenRole(environmentId: EnvironmentId): MachineTokenRole {
  return {
    allowed_policies: [machineName(environmentId)],
    orphan: true,
    renewable: false,
    token_no_default_policy: true,
    token_explicit_max_ttl: LIMITS.machineToken.maxTtlSeconds,
    token_type: "service",
    token_period: 0,
    token_num_uses: 0,
  };
}
