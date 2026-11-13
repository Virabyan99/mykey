// The provisioner identity's whole reach in OpenBao (Run 3.8, P-55): read the
// organization objects its drift sweep compares, and read or write the
// per-environment machine policy and token role. Reached only through
// `@mykey/openbao/provisioner`; apps/provisioner never imports `/admin`.
//
// Every answer is an `Answer`: a refusal is `denied`, a missing connection is
// `unreachable`, a sealed server `sealed`, and anything that does not say what
// happened is `unknown` — never a failure the caller could take as "not done".
import { LIMITS } from "@mykey/contracts";
import {
  appRoleLogin,
  baoCall,
  record,
  resolveTarget,
  type BaoCall,
  type OpenBaoTarget,
  type ResolvedTarget,
} from "./client.ts";
import { isMachineName, isOrganizationNamespace } from "./paths.ts";
import type { AppRoleName, MachineTokenRole } from "./policies.ts";

export type AnswerCause = "denied" | "unreachable" | "sealed" | "unknown";
export type Answer<T> = { ok: true; value: T } | { ok: false; cause: AnswerCause };

/** The fields of a machine token role that a read returns (`token_num_uses` is omitted when 0). */
export type ReadableTokenRole = Omit<MachineTokenRole, "token_num_uses">;

const fail = (cause: AnswerCause): { ok: false; cause: AnswerCause } => ({ ok: false, cause });

function requireMachineName(name: string): void {
  if (!isMachineName(name)) throw new Error("invalid machine name");
}

export class ProvisionerClient {
  readonly #target: OpenBaoTarget;
  readonly #resolved: ResolvedTarget;
  readonly #namespace: string;
  readonly #credential: { roleId: string; secretId: string };
  #token: string | null = null;

  constructor(
    target: OpenBaoTarget,
    namespace: string,
    credential: { roleId: string; secretId: string },
  ) {
    if (!isOrganizationNamespace(namespace)) throw new Error("invalid namespace");
    this.#target = target;
    this.#resolved = resolveTarget(target);
    this.#namespace = namespace;
    this.#credential = credential;
  }

  async #login(): Promise<Answer<string>> {
    if (this.#token !== null) return { ok: true, value: this.#token };
    const login = await appRoleLogin(
      this.#target,
      this.#namespace,
      this.#credential.roleId,
      this.#credential.secretId,
    );
    if (login.ok) {
      this.#token = login.data.token;
      return { ok: true, value: login.data.token };
    }
    if (login.kind === "invalid" && login.status === 0) return fail("unreachable");
    if (login.kind === "sealed") return fail("sealed");
    // An AppRole login refused for a bad or destroyed secret id answers 400.
    if (login.kind === "denied" || (login.kind === "invalid" && login.status === 400)) {
      return fail("denied");
    }
    return fail("unknown");
  }

  async #send(
    method: BaoCall["method"],
    path: string,
    body?: unknown,
  ): Promise<Answer<{ status: number; body: unknown }>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.#login();
      if (!token.ok) return token;
      const outcome = await baoCall(this.#resolved, {
        method,
        path,
        namespace: this.#namespace,
        token: token.value,
        deadlineMs: LIMITS.deadlines.backendCallMs,
        ...(body === undefined ? {} : { body }),
      });
      if (outcome.kind === "invalid") return fail("unreachable");
      if (outcome.kind === "unknown") return fail("unknown");
      if (outcome.status === 403 && attempt === 0) {
        // The token may have expired: log in once more before calling it a refusal.
        this.#token = null;
        continue;
      }
      if (outcome.status === 403) return fail("denied");
      if (outcome.status === 503) return fail("sealed");
      return { ok: true, value: outcome };
    }
    return fail("denied");
  }

  /** A read: the body's `data` on 200, null on 404 (or the given absent statuses). */
  async #read(
    path: string,
    absent: readonly number[] = [404],
  ): Promise<Answer<Record<string, unknown> | null>> {
    const answer = await this.#send("GET", path);
    if (!answer.ok) return answer;
    const { status, body } = answer.value;
    if (status === 200) return { ok: true, value: record(record(body).data) };
    if (absent.includes(status)) return { ok: true, value: null };
    return fail("unknown");
  }

  /** A write: done on 200/204; anything else is unknown, since it may have been applied. */
  async #write(method: BaoCall["method"], path: string, body: unknown): Promise<Answer<void>> {
    const answer = await this.#send(method, path, body);
    if (!answer.ok) return answer;
    const { status } = answer.value;
    if (status === 200 || status === 204) return { ok: true, value: undefined };
    if (status >= 400 && status < 500 && status !== 429) return fail("denied");
    return fail("unknown");
  }

  async #policy(name: string): Promise<Answer<string | null>> {
    const answer = await this.#read(`sys/policies/acl/${name}`);
    if (!answer.ok || answer.value === null) return answer as Answer<null>;
    const policy = answer.value.policy;
    return typeof policy === "string" ? { ok: true, value: policy } : fail("unknown");
  }

  readOrgPolicy(name: AppRoleName): Promise<Answer<string | null>> {
    return this.#policy(name);
  }

  /** `sys/mounts/kv`; an absent mount answers 400 on OpenBao 2.7. */
  readKvMount(): Promise<Answer<Record<string, unknown> | null>> {
    return this.#read("sys/mounts/kv", [400, 404]);
  }

  readKvConfig(): Promise<Answer<Record<string, unknown> | null>> {
    return this.#read("kv/config", [400, 404]);
  }

  readMachinePolicy(name: string): Promise<Answer<string | null>> {
    requireMachineName(name);
    return this.#policy(name);
  }

  putMachinePolicy(name: string, hcl: string): Promise<Answer<void>> {
    requireMachineName(name);
    return this.#write("PUT", `sys/policies/acl/${name}`, { policy: hcl });
  }

  async readMachineTokenRole(name: string): Promise<Answer<ReadableTokenRole | null>> {
    requireMachineName(name);
    const answer = await this.#read(`auth/token/roles/${name}`);
    if (!answer.ok || answer.value === null) return answer as Answer<null>;
    const data = answer.value;
    return {
      ok: true,
      value: {
        allowed_policies: data.allowed_policies,
        orphan: data.orphan,
        renewable: data.renewable,
        token_no_default_policy: data.token_no_default_policy,
        token_explicit_max_ttl: data.token_explicit_max_ttl,
        token_type: data.token_type,
        token_period: data.token_period,
      } as ReadableTokenRole,
    };
  }

  putMachineTokenRole(name: string, role: MachineTokenRole): Promise<Answer<void>> {
    requireMachineName(name);
    return this.#write("POST", `auth/token/roles/${name}`, role);
  }

  /** Revokes the client's own token, if it logged in. */
  async close(): Promise<void> {
    if (this.#token === null) return;
    const token = this.#token;
    this.#token = null;
    await baoCall(this.#resolved, {
      method: "POST",
      path: "auth/token/revoke-self",
      namespace: this.#namespace,
      token,
      deadlineMs: LIMITS.deadlines.backendCallMs,
    });
  }
}
