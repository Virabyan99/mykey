// The only place an OpenBao namespace, KV path or token-role name is built.
// Builders validate every id and name and throw a fixed message that never
// contains the input; validators accept exactly the shapes the builders produce,
// so the client can refuse anything that did not come from here.
import {
  checkSecretName,
  environmentIdSchema,
  organizationIdSchema,
  projectIdSchema,
  type EnvironmentId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";

// Lower case only: one id has exactly one backend path.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const NAMESPACE_SHAPE = new RegExp(`^org-(${UUID})$`);
const PREFIX_SHAPE = new RegExp(`^p/(${UUID})/e/(${UUID})/$`);
const SECRET_PATH_SHAPE = new RegExp(`^p/(${UUID})/e/(${UUID})/([^/]*)$`);
const MACHINE_NAME_SHAPE = new RegExp(`^machine-env-(${UUID})$`);

interface IdSchema {
  safeParse(input: unknown): { success: boolean };
}

function isId(schema: IdSchema, input: string): boolean {
  return CANONICAL_UUID.test(input) && schema.safeParse(input).success;
}

function requireId(schema: IdSchema, kind: string, input: string): void {
  if (!isId(schema, input)) throw new Error(`invalid ${kind} id`);
}

export function namespaceFor(organizationId: OrganizationId): string {
  requireId(organizationIdSchema, "organization", organizationId);
  return `org-${organizationId}`;
}

export function environmentPrefix(projectId: ProjectId, environmentId: EnvironmentId): string {
  requireId(projectIdSchema, "project", projectId);
  requireId(environmentIdSchema, "environment", environmentId);
  return `p/${projectId}/e/${environmentId}/`;
}

export function secretPath(
  projectId: ProjectId,
  environmentId: EnvironmentId,
  name: string,
): string {
  const prefix = environmentPrefix(projectId, environmentId);
  const checked = checkSecretName(name);
  if (!checked.ok) throw new Error(`invalid secret name: ${checked.rule}`);
  return `${prefix}${checked.value}`;
}

export function machineName(environmentId: EnvironmentId): string {
  requireId(environmentIdSchema, "environment", environmentId);
  return `machine-env-${environmentId}`;
}

export function isOrganizationNamespace(value: string): boolean {
  const match = NAMESPACE_SHAPE.exec(value);
  return match !== null && isId(organizationIdSchema, match[1] ?? "");
}

export function isEnvironmentPrefix(value: string): boolean {
  const match = PREFIX_SHAPE.exec(value);
  return (
    match !== null &&
    isId(projectIdSchema, match[1] ?? "") &&
    isId(environmentIdSchema, match[2] ?? "")
  );
}

export function isSecretPath(value: string): boolean {
  const match = SECRET_PATH_SHAPE.exec(value);
  return (
    match !== null &&
    isId(projectIdSchema, match[1] ?? "") &&
    isId(environmentIdSchema, match[2] ?? "") &&
    checkSecretName(match[3] ?? "").ok
  );
}

export function isMachineName(value: string): boolean {
  const match = MACHINE_NAME_SHAPE.exec(value);
  return match !== null && isId(environmentIdSchema, match[1] ?? "");
}
