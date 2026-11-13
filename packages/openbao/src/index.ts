// @mykey/openbao — the narrow OpenBao client, backend paths and policy
// templates. Operator authority is a separate entry point, `@mykey/openbao/admin`,
// and is deliberately not re-exported here.
export {
  AUTHORITY_ACTIONS,
  AUTHORITY_MATRIX,
  COLUMNS,
  IDENTITIES,
  ROOT_CONTROLS,
  SELF_OPERATIONS,
  cellColumn,
  cellKey,
  controlOf,
  type AuthorityCell,
  type AuthorityRequest,
  type Column,
  type Identity,
  type RootControl,
  type Target,
} from "./authority.ts";
export {
  OpenBaoClient,
  appRoleLogin,
  type BaoAuth,
  type BaoFailure,
  type BaoFailureKind,
  type BaoResult,
  type Correlation,
  type InlineAppRole,
  type IssuedToken,
  type KvMetadata,
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
