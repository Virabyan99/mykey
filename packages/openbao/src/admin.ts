// Operator authority over OpenBao: namespaces, mounts, policies, AppRoles and
// token roles. Reached only through `@mykey/openbao/admin`; apps/api must never
// import it (tests/unit/skeleton checks the import graph).
//
// Every method throws on anything but the expected answer. Error messages name
// the method, the path and the HTTP status only — never a body, a token or a
// secret id.
import { setTimeout as sleep } from "node:timers/promises";
import { LIMITS } from "@mykey/contracts";
import {
  baoCall,
  record,
  resolveTarget,
  type BaoCall,
  type OpenBaoTarget,
  type ResolvedTarget,
} from "./client.ts";
import { isOrganizationNamespace } from "./paths.ts";
import type { AppRoleName, MachineTokenRole } from "./policies.ts";

/** The fields of a machine token role that a read returns (all but `token_num_uses`, omitted when 0). */
export type ReadableTokenRole = Omit<MachineTokenRole, "token_num_uses">;

const AUDITED_HEADERS = ["x-mykey-operation-id", "x-mykey-dispatch-id"] as const;
const OBJECT_NAME = /^[a-z][a-z0-9-]{0,127}$/;
const KV_UPGRADE_TIMEOUT_MS = 30_000;

function requireNamespace(namespace: string, allowRoot: boolean): void {
  if (namespace === "" ? !allowRoot : !isOrganizationNamespace(namespace)) {
    throw new Error("invalid namespace");
  }
}

function requireName(name: string): void {
  if (!OBJECT_NAME.test(name)) throw new Error("invalid object name");
}

export class OpenBaoAdmin {
  readonly #target: ResolvedTarget;
  readonly #token: string;

  constructor(target: OpenBaoTarget, operatorToken: string) {
    this.#target = resolveTarget(target);
    this.#token = operatorToken;
  }

  /** One request; returns the status and body of an answer in `expected`, throws otherwise. */
  async #request(
    method: BaoCall["method"],
    namespace: string,
    path: string,
    expected: readonly number[],
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const outcome = await baoCall(this.#target, {
      method,
      path,
      namespace,
      token: this.#token,
      deadlineMs: LIMITS.deadlines.backendCallMs,
      ...(body === undefined ? {} : { body }),
    });
    const where = `OpenBao ${method} ${path.split("?")[0] ?? ""}`;
    if (outcome.kind === "invalid") throw new Error(`${where}: no connection`);
    if (outcome.kind === "unknown") throw new Error(`${where}: outcome unknown (${outcome.cause})`);
    if (!expected.includes(outcome.status)) {
      throw new Error(`${where}: HTTP ${outcome.status}`);
    }
    return outcome;
  }

  async registerAuditHeaders(): Promise<void> {
    for (const header of AUDITED_HEADERS) {
      await this.#request("POST", "", `sys/config/auditing/request-headers/${header}`, [200, 204], {
        hmac: false,
      });
    }
  }

  async createNamespace(namespace: string): Promise<void> {
    requireNamespace(namespace, false);
    await this.#request("POST", "", `sys/namespaces/${namespace}`, [200, 204]);
  }

  /** KV v2 at `kv`: cas_required, 20 versions, no automatic deletion. Waits out "Upgrading". */
  async mountKv(namespace: string): Promise<void> {
    requireNamespace(namespace, false);
    await this.#request("POST", namespace, "sys/mounts/kv", [204], {
      type: "kv",
      options: { version: "2" },
    });
    const deadline = Date.now() + KV_UPGRADE_TIMEOUT_MS;
    // A new KV v2 mount answers 400 "Upgrading…" for a moment.
    while ((await this.#request("GET", namespace, "kv/config", [200, 400])).status !== 200) {
      if (Date.now() > deadline) throw new Error("OpenBao kv/config: mount upgrade timed out");
      await sleep(200);
    }
    await this.#request("POST", namespace, "kv/config", [200, 204], {
      cas_required: true,
      max_versions: LIMITS.secret.versionsKept,
      delete_version_after: "0s",
    });
  }

  async enableAppRole(namespace: string): Promise<void> {
    requireNamespace(namespace, true);
    await this.#request("POST", namespace, "sys/auth/approle", [204], { type: "approle" });
  }

  async putPolicy(namespace: string, name: string, hcl: string): Promise<void> {
    requireNamespace(namespace, true);
    requireName(name);
    await this.#request("PUT", namespace, `sys/policies/acl/${name}`, [200, 204], {
      policy: hcl,
    });
  }

  async readPolicy(namespace: string, name: string): Promise<string | null> {
    requireNamespace(namespace, true);
    requireName(name);
    const answer = await this.#request("GET", namespace, `sys/policies/acl/${name}`, [200, 404]);
    if (answer.status === 404) return null;
    const policy = record(record(answer.body).data).policy;
    if (typeof policy !== "string") throw new Error("OpenBao policy read: malformed answer");
    return policy;
  }

  /** The AppRole `name` whose tokens carry only the policy `name` (P-22). */
  async putAppRole(
    namespace: string,
    name: AppRoleName,
    ttlSeconds: number,
  ): Promise<{ roleId: string }> {
    requireNamespace(namespace, true);
    requireName(name);
    await this.#request("POST", namespace, `auth/approle/role/${name}`, [200, 204], {
      token_policies: [name],
      token_no_default_policy: true,
      token_type: "service",
      token_ttl: ttlSeconds,
      token_max_ttl: ttlSeconds,
      secret_id_num_uses: 0,
    });
    const answer = await this.#request(
      "GET",
      namespace,
      `auth/approle/role/${name}/role-id`,
      [200],
    );
    const roleId = record(record(answer.body).data).role_id;
    if (typeof roleId !== "string") throw new Error("OpenBao role-id read: malformed answer");
    return { roleId };
  }

  async newSecretId(namespace: string, name: string): Promise<{ secretId: string }> {
    requireNamespace(namespace, true);
    requireName(name);
    const answer = await this.#request(
      "POST",
      namespace,
      `auth/approle/role/${name}/secret-id`,
      [200],
    );
    const secretId = record(record(answer.body).data).secret_id;
    if (typeof secretId !== "string") throw new Error("OpenBao secret-id: malformed answer");
    return { secretId };
  }

  async putTokenRole(namespace: string, name: string, role: MachineTokenRole): Promise<void> {
    requireNamespace(namespace, false);
    requireName(name);
    await this.#request("POST", namespace, `auth/token/roles/${name}`, [200, 204], role);
  }

  /**
   * The stored values of the readable fields of MachineTokenRole, as OpenBao
   * reports them. OpenBao 2.7.2 leaves `token_num_uses` out of a role read when
   * it is 0 (the machine roles' value), so it is not read back (Run 2.1 note).
   */
  async readTokenRole(namespace: string, name: string): Promise<ReadableTokenRole | null> {
    requireNamespace(namespace, false);
    requireName(name);
    const answer = await this.#request("GET", namespace, `auth/token/roles/${name}`, [200, 404]);
    if (answer.status === 404) return null;
    const data = record(record(answer.body).data);
    // Values are copied as read, not coerced: a caller compares them with toEqual.
    return {
      allowed_policies: data.allowed_policies,
      orphan: data.orphan,
      renewable: data.renewable,
      token_no_default_policy: data.token_no_default_policy,
      token_explicit_max_ttl: data.token_explicit_max_ttl,
      token_type: data.token_type,
      token_period: data.token_period,
    } as ReadableTokenRole;
  }

  /** `LIST auth/token/accessors` (needs sudo). "" is the root namespace. */
  async listAccessors(namespace: string): Promise<string[]> {
    requireNamespace(namespace, true);
    const answer = await this.#request(
      "GET",
      namespace,
      "auth/token/accessors?list=true",
      [200, 404],
    );
    if (answer.status === 404) return [];
    const keys = record(record(answer.body).data).keys;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) {
      throw new Error("OpenBao accessor list: malformed answer");
    }
    return keys;
  }
}
