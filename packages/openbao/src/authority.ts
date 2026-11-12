// The authority matrix (Run 2.1, PO-3): every identity × action × target, each a
// concrete raw request to OpenBao, with the answer it must get. The integration
// test sends every cell with a real token; scripts/authority-matrix.ts renders
// the result into docs/evidence/session-2/authority-matrix.md.
//
// Expected allows are exactly the path blocks of infra/openbao/policies/*.hcl
// (Doc 06 §5); a token's own lookup-self and revoke-self rows also hold when the
// request names another namespace (SELF_OPERATIONS, observed and explained in
// D-17). Everything else is a denial: HTTP 403, except where OpenBao
// answers before it evaluates any policy (`expectStatus`, with the reason).
//
// Placeholders in `request.path` and in string values of `request.body`, filled
// by the test for the cell's target:
//   {pid} {eid}     the target's project and environment
//   {seed}          a secret that exists in that environment (version 1)
//   {victim}        a secret written (version 1) just before this request
//   {fresh}         a new unique lower-case name; nothing exists under it
//   {accessor}      accessor of a short-lived token minted with the root token
//                   in the target namespace just before this request
//   {ns}/           a path that starts with the target namespace is sent to the
//                   root namespace (namespace in the path, not in the header)
//   {machinePolicy} {runtimePolicy}   the canonical rendered policy text
import { LIMITS } from "@mykey/contracts";
import { APPROLE_TOKEN_TTL_SECONDS } from "./policies.ts";

export type Identity = "runtime" | "issuer" | "provisioner" | "machine" | "backup";
export const IDENTITIES: readonly Identity[] = [
  "runtime",
  "issuer",
  "provisioner",
  "machine",
  "backup",
];

export type Target = "own" | "other_environment" | "other_organization" | "root";

/** A target as a matrix column: `other_organization` is sent two ways. */
export type Column =
  "own" | "other_environment" | "other_organization" | "other_organization_path" | "root";
export const COLUMNS: readonly Column[] = [
  "own",
  "other_environment",
  "other_organization",
  "other_organization_path",
  "root",
];

export interface AuthorityRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export interface AuthorityCell {
  identity: Identity;
  action: string;
  request: AuthorityRequest;
  target: Target;
  expect: "allow" | "deny";
  /** The status of a denial that OpenBao gives before policy evaluation (default 403). */
  expectStatus?: number;
  /** Why the cell is not a plain 200/204 or 403. */
  reason?: string;
}

/**
 * The control of a request that no identity may make, when it is not simply
 * the root token answering 200 or 204. `privateStack`: the root token sends it
 * to a stack of its own. `mintedToken`: the root token mints a short-lived,
 * renewable token with the `default` policy in the column's namespace, and that
 * token sends the request.
 */
export interface RootControl {
  action: string;
  column: Column;
  status: number;
  reason: string;
  privateStack?: true;
  mintedToken?: true;
}

const NS_PREFIX = "{ns}/";

interface ActionSpec {
  action: string;
  request: AuthorityRequest;
  columns: readonly Column[];
}

const ENVIRONMENT: readonly Column[] = [
  "own",
  "other_environment",
  "other_organization",
  "other_organization_path",
];
const NAMESPACE: readonly Column[] = ["own", "other_organization", "other_organization_path"];
const EVERYWHERE: readonly Column[] = [
  "own",
  "other_organization",
  "other_organization_path",
  "root",
];

const SECRET = "kv/data/p/{pid}/e/{eid}";
const SYNTHETIC_ENVELOPE = {
  value: "synthetic-authority",
  operation_id: "00000000-0000-4000-8000-000000000000",
  format: 1,
};
const TOKEN_REQUEST = { ttl: "60s", policies: ["machine-env-{eid}"], no_default_policy: true };
const MACHINE_ROLE = {
  allowed_policies: ["machine-env-{eid}"],
  orphan: true,
  renewable: false,
  token_no_default_policy: true,
  token_explicit_max_ttl: LIMITS.machineToken.maxTtlSeconds,
  token_type: "service",
  token_period: 0,
  token_num_uses: 0,
};

const ACTIONS: readonly ActionSpec[] = [
  // KV
  {
    action: "kv.write",
    request: {
      method: "POST",
      path: `${SECRET}/{fresh}`,
      body: { options: { cas: 0 }, data: SYNTHETIC_ENVELOPE },
    },
    columns: ENVIRONMENT,
  },
  { action: "kv.read", request: { method: "GET", path: `${SECRET}/{seed}` }, columns: ENVIRONMENT },
  {
    action: "kv.read_version_1",
    request: { method: "GET", path: `${SECRET}/{seed}?version=1` },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.list_environment",
    request: { method: "GET", path: "kv/metadata/p/{pid}/e/{eid}/?list=true" },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.list_project",
    request: { method: "GET", path: "kv/metadata/p/{pid}/e/?list=true" },
    columns: NAMESPACE,
  },
  {
    action: "kv.list_projects",
    request: { method: "GET", path: "kv/metadata/p/?list=true" },
    columns: NAMESPACE,
  },
  {
    action: "kv.list_mount",
    request: { method: "GET", path: "kv/metadata/?list=true" },
    columns: NAMESPACE,
  },
  {
    action: "kv.soft_delete",
    request: {
      method: "POST",
      path: "kv/delete/p/{pid}/e/{eid}/{victim}",
      body: { versions: [1] },
    },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.delete_data",
    request: { method: "DELETE", path: `${SECRET}/{victim}` },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.undelete",
    request: {
      method: "POST",
      path: "kv/undelete/p/{pid}/e/{eid}/{victim}",
      body: { versions: [1] },
    },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.destroy",
    request: {
      method: "POST",
      path: "kv/destroy/p/{pid}/e/{eid}/{victim}",
      body: { versions: [1] },
    },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.delete_metadata",
    request: { method: "DELETE", path: "kv/metadata/p/{pid}/e/{eid}/{victim}" },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.read_metadata",
    request: { method: "GET", path: "kv/metadata/p/{pid}/e/{eid}/{seed}" },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.patch",
    request: {
      method: "PATCH",
      path: `${SECRET}/{victim}`,
      body: { options: { cas: 1 }, data: { value: "synthetic-patched" } },
    },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.read_subkeys",
    request: { method: "GET", path: "kv/subkeys/p/{pid}/e/{eid}/{seed}" },
    columns: ENVIRONMENT,
  },
  {
    action: "kv.write_config",
    request: {
      method: "POST",
      path: "kv/config",
      body: {
        cas_required: true,
        max_versions: LIMITS.secret.versionsKept,
        delete_version_after: "0s",
      },
    },
    columns: NAMESPACE,
  },
  { action: "mount.read", request: { method: "GET", path: "sys/mounts/kv" }, columns: NAMESPACE },
  { action: "kv.read_config", request: { method: "GET", path: "kv/config" }, columns: NAMESPACE },
  {
    action: "mount.tune",
    request: { method: "POST", path: "sys/mounts/kv/tune", body: { description: "kv" } },
    columns: NAMESPACE,
  },
  // Tokens
  {
    action: "token.create",
    request: { method: "POST", path: "auth/token/create", body: TOKEN_REQUEST },
    columns: EVERYWHERE,
  },
  {
    action: "token.create_orphan",
    request: { method: "POST", path: "auth/token/create-orphan", body: TOKEN_REQUEST },
    columns: EVERYWHERE,
  },
  {
    action: "token.create_from_role",
    request: { method: "POST", path: "auth/token/create/machine-env-{eid}", body: TOKEN_REQUEST },
    columns: ENVIRONMENT,
  },
  {
    action: "token.renew_self",
    request: { method: "POST", path: "auth/token/renew-self", body: {} },
    columns: EVERYWHERE,
  },
  {
    action: "token.lookup_self",
    request: { method: "GET", path: "auth/token/lookup-self" },
    columns: EVERYWHERE,
  },
  {
    action: "token.revoke_self",
    request: { method: "POST", path: "auth/token/revoke-self" },
    columns: EVERYWHERE,
  },
  {
    action: "token.lookup_accessor",
    request: {
      method: "POST",
      path: "auth/token/lookup-accessor",
      body: { accessor: "{accessor}" },
    },
    columns: EVERYWHERE,
  },
  {
    action: "token.revoke_accessor",
    request: {
      method: "POST",
      path: "auth/token/revoke-accessor",
      body: { accessor: "{accessor}" },
    },
    columns: EVERYWHERE,
  },
  {
    action: "token.list_accessors",
    request: { method: "GET", path: "auth/token/accessors?list=true" },
    columns: EVERYWHERE,
  },
  {
    action: "token_role.read",
    request: { method: "GET", path: "auth/token/roles/machine-env-{eid}" },
    columns: ENVIRONMENT,
  },
  {
    action: "token_role.write",
    request: { method: "POST", path: "auth/token/roles/machine-env-{eid}", body: MACHINE_ROLE },
    columns: ENVIRONMENT,
  },
  {
    action: "token_role.write_other",
    request: { method: "POST", path: "auth/token/roles/other", body: MACHINE_ROLE },
    columns: EVERYWHERE,
  },
  // Policies and auth methods
  {
    action: "policy.read_machine",
    request: { method: "GET", path: "sys/policies/acl/machine-env-{eid}" },
    columns: ENVIRONMENT,
  },
  {
    action: "policy.write_machine",
    request: {
      method: "PUT",
      path: "sys/policies/acl/machine-env-{eid}",
      body: { policy: "{machinePolicy}" },
    },
    columns: ENVIRONMENT,
  },
  {
    action: "policy.write_runtime",
    request: {
      method: "PUT",
      path: "sys/policies/acl/runtime",
      body: { policy: "{runtimePolicy}" },
    },
    columns: EVERYWHERE,
  },
  // Run 3.8: the provisioner reads the organization policies its sweep compares.
  ...(["runtime", "issuer", "provisioner"] as const).map((name) => ({
    action: `policy.read_${name}`,
    request: { method: "GET" as const, path: `sys/policies/acl/${name}` },
    columns: NAMESPACE,
  })),
  {
    action: "policy.list",
    request: { method: "GET", path: "sys/policies/acl?list=true" },
    columns: EVERYWHERE,
  },
  { action: "auth.read", request: { method: "GET", path: "sys/auth" }, columns: EVERYWHERE },
  {
    action: "auth.enable",
    request: { method: "POST", path: "sys/auth/{fresh}", body: { type: "userpass" } },
    columns: EVERYWHERE,
  },
  {
    action: "approle.write_issuer",
    request: {
      method: "POST",
      path: "auth/approle/role/issuer",
      body: {
        token_policies: ["issuer"],
        token_no_default_policy: true,
        token_type: "service",
        token_ttl: APPROLE_TOKEN_TTL_SECONDS.issuer,
        token_max_ttl: APPROLE_TOKEN_TTL_SECONDS.issuer,
        secret_id_num_uses: 0,
      },
    },
    columns: NAMESPACE,
  },
  {
    action: "approle.secret_id",
    request: { method: "POST", path: "auth/approle/role/runtime/secret-id" },
    columns: NAMESPACE,
  },
  {
    action: "approle.read",
    request: { method: "GET", path: "auth/approle/role/runtime" },
    columns: NAMESPACE,
  },
  // System
  {
    action: "namespace.list",
    request: { method: "GET", path: "sys/namespaces?list=true" },
    columns: EVERYWHERE,
  },
  {
    action: "namespace.create",
    request: { method: "POST", path: "sys/namespaces/{fresh}" },
    columns: EVERYWHERE,
  },
  {
    action: "raft.snapshot",
    request: { method: "GET", path: "sys/storage/raft/snapshot" },
    columns: EVERYWHERE,
  },
  { action: "audit.read", request: { method: "GET", path: "sys/audit" }, columns: EVERYWHERE },
  {
    action: "audit.headers",
    request: { method: "GET", path: "sys/config/auditing/request-headers" },
    columns: EVERYWHERE,
  },
  { action: "seal", request: { method: "PUT", path: "sys/seal" }, columns: EVERYWHERE },
  { action: "raw.read", request: { method: "GET", path: "sys/raw/core" }, columns: EVERYWHERE },
];

/** `identity action column` triples that the policy templates allow. */
const ALLOWED: readonly string[] = [
  ...["own", "other_environment"].flatMap((column) => [
    ...[
      "kv.write",
      "kv.read",
      "kv.read_version_1",
      "kv.list_environment",
      "kv.soft_delete",
      "kv.undelete",
      "kv.read_metadata",
    ].map((action) => `runtime ${action} ${column}`),
    `issuer token.create_from_role ${column}`,
    `issuer token_role.read ${column}`,
    `issuer policy.read_machine ${column}`,
    `provisioner token_role.read ${column}`,
    `provisioner token_role.write ${column}`,
    `provisioner policy.read_machine ${column}`,
    `provisioner policy.write_machine ${column}`,
  ]),
  "runtime kv.list_project own",
  "runtime kv.list_projects own",
  "runtime token.lookup_self own",
  "runtime token.revoke_self own",
  "issuer token.lookup_accessor own",
  "issuer token.revoke_accessor own",
  "issuer token.revoke_self own",
  "provisioner token.revoke_self own",
  // Run 3.8: reads for verification and drift; nothing it can write changes.
  "provisioner policy.read_runtime own",
  "provisioner policy.read_issuer own",
  "provisioner policy.read_provisioner own",
  "provisioner mount.read own",
  "provisioner kv.read_config own",
  "machine kv.read own",
  // Doc 06 §5: a raw machine token can read retained versions; the product API does not.
  "machine kv.read_version_1 own",
  "machine kv.list_environment own",
  "machine token.lookup_self own",
  "backup raft.snapshot root",
];

const ROOT_ONLY_REASON =
  "OpenBao answers 400 before any policy: root-namespace-only endpoint called in a namespace";

/** Denials that OpenBao gives before it evaluates a policy, for every identity. */
const BEFORE_POLICY: readonly {
  actions: readonly string[];
  columns: readonly Column[];
  status: number;
  reason: string;
}[] = [
  {
    actions: ["raft.snapshot", "audit.read", "audit.headers", "seal", "raw.read"],
    columns: NAMESPACE,
    status: 400,
    reason: ROOT_ONLY_REASON,
  },
];

export const ROOT_CONTROLS: readonly RootControl[] = [
  ...NAMESPACE.flatMap((column) =>
    ["raft.snapshot", "audit.read", "audit.headers", "seal", "raw.read"].map(
      (action): RootControl => ({ action, column, status: 400, reason: ROOT_ONLY_REASON }),
    ),
  ),
  {
    action: "raw.read",
    column: "root",
    status: 404,
    reason:
      "the raw storage endpoint is not enabled in the server configuration, so nobody can use it; the identities' 403 is the policy answer given before routing",
  },
  {
    action: "seal",
    column: "root",
    status: 204,
    reason:
      "sealing the shared stack would stop every other suite, so the root token seals a stack of its own",
    privateStack: true,
  },
  ...(["own", "other_organization", "other_organization_path", "root"] as const).map(
    (column): RootControl => ({
      action: "token.renew_self",
      column,
      status: 200,
      reason:
        "the root token has no lease to renew, so the control is a 120 s renewable token with the default policy, minted by the root token in that namespace, renewing itself",
      mintedToken: true,
    }),
  ),
];

const SELF_REASON =
  "self operation: OpenBao applies it to the caller's own token under the policies of the token's own namespace, whatever namespace the request names";

/**
 * The token's own self operations, observed allowed wherever the request is
 * sent (Run 2.1, D-17): the same template rows, not new rights.
 */
export const SELF_OPERATIONS: readonly string[] = (
  ["other_organization", "other_organization_path", "root"] as const
).flatMap((column) => [
  `runtime token.lookup_self ${column}`,
  `machine token.lookup_self ${column}`,
  `runtime token.revoke_self ${column}`,
  `issuer token.revoke_self ${column}`,
  `provisioner token.revoke_self ${column}`,
]);

function columnTarget(column: Column): Target {
  return column === "other_organization_path" ? "other_organization" : column;
}

function columnRequest(request: AuthorityRequest, column: Column): AuthorityRequest {
  return column === "other_organization_path"
    ? { ...request, path: `${NS_PREFIX}${request.path}` }
    : request;
}

/** The column a cell is shown in. */
export function cellColumn(cell: AuthorityCell): Column {
  return cell.request.path.startsWith(NS_PREFIX) ? "other_organization_path" : cell.target;
}

/** A stable identifier: `identity action column`. */
export function cellKey(cell: AuthorityCell): string {
  return `${cell.identity} ${cell.action} ${cellColumn(cell)}`;
}

function buildMatrix(): AuthorityCell[] {
  const allowed = new Set([...ALLOWED, ...SELF_OPERATIONS]);
  const self = new Set(SELF_OPERATIONS);
  const cells: AuthorityCell[] = [];
  for (const spec of ACTIONS) {
    for (const column of spec.columns) {
      const before = BEFORE_POLICY.find(
        (entry) => entry.actions.includes(spec.action) && entry.columns.includes(column),
      );
      for (const identity of IDENTITIES) {
        const key = `${identity} ${spec.action} ${column}`;
        const allow = allowed.has(key);
        cells.push({
          identity,
          action: spec.action,
          request: columnRequest(spec.request, column),
          target: columnTarget(column),
          expect: allow ? "allow" : "deny",
          ...(before === undefined || allow
            ? {}
            : { expectStatus: before.status, reason: before.reason }),
          ...(self.has(key) ? { reason: SELF_REASON } : {}),
        });
      }
    }
  }
  return cells;
}

export const AUTHORITY_MATRIX: readonly AuthorityCell[] = Object.freeze(buildMatrix());

/** The actions in matrix order. */
export const AUTHORITY_ACTIONS: readonly string[] = ACTIONS.map((spec) => spec.action);

/**
 * Who shows that a denial is a denial: an identity allowed the same request in
 * the same column, or else the root token (with its answer when not 2xx).
 */
export function controlOf(
  cell: AuthorityCell,
): { by: Identity } | { by: "root"; control: RootControl | undefined } {
  const column = cellColumn(cell);
  const allowed = AUTHORITY_MATRIX.find(
    (other) =>
      other.action === cell.action && cellColumn(other) === column && other.expect === "allow",
  );
  if (allowed !== undefined) return { by: allowed.identity };
  return {
    by: "root",
    control: ROOT_CONTROLS.find((entry) => entry.action === cell.action && entry.column === column),
  };
}
