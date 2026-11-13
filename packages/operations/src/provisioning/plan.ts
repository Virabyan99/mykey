// What an organization's OpenBao objects must be (P-54, P-56), how a stored
// object is compared with it, and the digest the drift sweep compares later.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LIMITS, type OrganizationId } from "@mykey/contracts";
import {
  APPROLE_TOKEN_TTL_SECONDS,
  namespaceFor,
  renderPolicy,
  type AppRoleName,
} from "@mykey/openbao";

export const APPROLE_NAMES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];

export interface OrganizationPlan {
  namespace: string;
  kvMount: { type: "kv"; version: "2" };
  kvConfig: { cas_required: true; max_versions: number; delete_version_after: string };
  policies: Record<AppRoleName, string>;
  /** Each AppRole's fields as OpenBao reads them back. */
  appRoles: Record<AppRoleName, Record<string, unknown>>;
  /** The TTL and the bound addresses to write each AppRole with. */
  appRoleWrites: Record<AppRoleName, { ttlSeconds: number; boundCidrs: readonly string[] }>;
}

/** OpenBao 2.7.2 reads a /32 of `token_bound_cidrs` back as the bare address (Run 3.8). */
function tokenCidrReadBack(cidr: string): string {
  return cidr.endsWith("/32") ? cidr.slice(0, -3) : cidr;
}

export function organizationPlan(
  organizationId: OrganizationId,
  boundCidrs: Record<AppRoleName, readonly string[]>,
): OrganizationPlan {
  const policies = {} as Record<AppRoleName, string>;
  const appRoles = {} as Record<AppRoleName, Record<string, unknown>>;
  const appRoleWrites = {} as OrganizationPlan["appRoleWrites"];
  for (const name of APPROLE_NAMES) {
    const ttl = APPROLE_TOKEN_TTL_SECONDS[name];
    const cidrs = boundCidrs[name];
    policies[name] = renderPolicy(name);
    appRoles[name] = {
      token_policies: [name],
      token_no_default_policy: true,
      token_type: "service",
      token_ttl: ttl,
      token_max_ttl: ttl,
      secret_id_num_uses: 0,
      secret_id_bound_cidrs: [...cidrs],
      token_bound_cidrs: cidrs.map(tokenCidrReadBack),
    };
    appRoleWrites[name] = { ttlSeconds: ttl, boundCidrs: cidrs };
  }
  return {
    namespace: namespaceFor(organizationId),
    kvMount: { type: "kv", version: "2" },
    kvConfig: {
      cas_required: true,
      max_versions: LIMITS.secret.versionsKept,
      delete_version_after: "0s",
    },
    policies,
    appRoles,
    appRoleWrites,
  };
}

/** The mount's type and KV version, from a `sys/mounts/kv` read. */
export function kvMountOf(read: Record<string, unknown>): { type: unknown; version: unknown } {
  const options = read.options;
  const version =
    typeof options === "object" && options !== null
      ? (options as Record<string, unknown>).version
      : undefined;
  return { type: read.type, version };
}

export function kvConfigOf(read: Record<string, unknown>): Record<string, unknown> {
  return {
    cas_required: read.cas_required,
    max_versions: read.max_versions,
    delete_version_after: read.delete_version_after,
  };
}

/** A mount written but not configured yet: OpenBao's defaults for a new KV v2 mount. */
export function isFreshKvConfig(read: Record<string, unknown>): boolean {
  return read.cas_required === false && read.max_versions === 0;
}

const LIST_FIELDS = ["token_policies", "secret_id_bound_cidrs", "token_bound_cidrs"];

/** True when every field of the plan's AppRole is what OpenBao read. */
export function appRoleEquals(
  read: Record<string, unknown>,
  planned: Record<string, unknown>,
): boolean {
  return Object.entries(planned).every(([field, value]) => {
    const actual = LIST_FIELDS.includes(field) ? (read[field] ?? []) : read[field];
    return isDeepStrictEqual(actual, value);
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 hex of the canonical JSON of what the provisioner identity can read:
 * the mount's type and version, `kv/config`'s three fields and the three
 * policy texts. The operator and the provisioner compute it the same way.
 */
export function configDigest(read: {
  kvMount: Record<string, unknown>;
  kvConfig: Record<string, unknown>;
  policies: Record<AppRoleName, string>;
}): string {
  const text = canonical({
    kvMount: kvMountOf(read.kvMount),
    kvConfig: kvConfigOf(read.kvConfig),
    policies: read.policies,
  });
  return createHash("sha256").update(text).digest("hex");
}
