// @mykey/openbao — the narrow OpenBao client, backend paths and policy
// templates. Operator authority is a separate entry point, `@mykey/openbao/admin`,
// and is deliberately not re-exported here.
export {
  OpenBaoClient,
  appRoleLogin,
  type BaoFailureKind,
  type BaoResult,
  type Correlation,
  type IssuedToken,
  type OpenBaoTarget,
  type SecretEnvelope,
  type TokenInfo,
} from "./client.ts";
export {
  environmentPrefix,
  isEnvironmentPrefix,
  isMachineName,
  isOrganizationNamespace,
  isSecretPath,
  machineName,
  namespaceFor,
  secretPath,
} from "./paths.ts";
export {
  APPROLE_TOKEN_TTL_SECONDS,
  machineTokenRole,
  renderMachinePolicy,
  renderPolicy,
  type AppRoleName,
  type MachineTokenRole,
  type PolicyKind,
} from "./policies.ts";
