// The API's OpenBao credentials as the host delivers them (Run 3.8): files in
// the API's secrets directory. The runtime credential is read on each call
// until all three files exist, then kept (Run 4.2, P-62). The issuer
// credential (Run 5.1, P-85) is read the same way; each `open` logs in once
// (a token of 60 s) and `close` revokes that token. The values never leave
// this module but in the clients.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { organizationIdSchema, type OrganizationId } from "@mykey/contracts";
import {
  OpenBaoClient,
  appRoleLogin,
  namespaceFor,
  type BaoResult,
  type OpenBaoTarget,
} from "@mykey/openbao";
import type { IssuerBao, IssuerSession, RuntimeBao } from "@mykey/operations";

interface AppRoleFiles {
  organizationId: OrganizationId;
  roleId: string;
  secretId: string;
}

function readAppRole(directory: string, identity: "runtime" | "issuer"): AppRoleFiles | null {
  try {
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    const organizationId = organizationIdSchema.safeParse(read("organization-id"));
    if (!organizationId.success) return null;
    const roleId = read(`${identity}-role-id`);
    const secretId = read(`${identity}-secret-id`);
    if (roleId === "" || secretId === "") return null;
    return { organizationId: organizationId.data, roleId, secretId };
  } catch {
    return null;
  }
}

interface Credential {
  organizationId: OrganizationId;
  client: OpenBaoClient;
}

function readCredential(target: OpenBaoTarget, directory: string): Credential | null {
  const files = readAppRole(directory, "runtime");
  if (files === null) return null;
  return {
    organizationId: files.organizationId,
    client: new OpenBaoClient(target, {
      namespace: namespaceFor(files.organizationId),
      auth: { inline: { roleId: files.roleId, secretId: files.secretId } },
    }),
  };
}

export function runtimeBaoFromDirectory(target: OpenBaoTarget, directory: string): RuntimeBao {
  let credential: Credential | null = null;
  const current = (): Credential | null => (credential ??= readCredential(target, directory));
  return {
    clientFor(organizationId) {
      const held = current();
      return held?.organizationId === organizationId ? held.client : null;
    },
    organizationId() {
      return current()?.organizationId ?? null;
    },
    withToken(organizationId, token) {
      const held = current();
      if (held?.organizationId !== organizationId) return null;
      return new OpenBaoClient(target, { namespace: namespaceFor(organizationId), token });
    },
  };
}

export function issuerBaoFromDirectory(target: OpenBaoTarget, directory: string): IssuerBao {
  let files: AppRoleFiles | null = null;
  return {
    async open(organizationId): Promise<BaoResult<IssuerSession> | null> {
      files ??= readAppRole(directory, "issuer");
      if (files?.organizationId !== organizationId) return null;
      const namespace = namespaceFor(organizationId);
      const login = await appRoleLogin(target, namespace, files.roleId, files.secretId);
      if (!login.ok) return login;
      const client = new OpenBaoClient(target, { namespace, token: login.data.token });
      let closed = false;
      return {
        ok: true,
        status: login.status,
        data: {
          client,
          async close() {
            if (closed) return;
            closed = true;
            await client.tokenRevokeSelf().catch(() => undefined);
          },
        },
      };
    },
  };
}
