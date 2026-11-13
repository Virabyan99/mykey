// The API's self-check at start (Run 3.8): where OpenBao is configured, log in
// with the delivered runtime credential and revoke the token at once. Only a
// log line in Session 3; Run 4.2 decides whether it gates /health.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { organizationIdSchema } from "@mykey/contracts";
import { OpenBaoClient, appRoleLogin, namespaceFor, type OpenBaoTarget } from "@mykey/openbao";

export type SelfCheck = "ok" | "refused" | "unreachable" | "absent";

function readCredential(directory: string) {
  try {
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    const organizationId = organizationIdSchema.safeParse(read("organization-id"));
    if (!organizationId.success) return null;
    return {
      organizationId: organizationId.data,
      roleId: read("runtime-role-id"),
      secretId: read("runtime-secret-id"),
    };
  } catch {
    return null;
  }
}

export async function runtimeSelfCheck(
  openbao: OpenBaoTarget | undefined,
  secretsDirectory: string,
): Promise<SelfCheck> {
  if (openbao === undefined) return "absent";
  const credential = readCredential(secretsDirectory);
  if (credential === null) return "absent";
  const namespace = namespaceFor(credential.organizationId);
  const login = await appRoleLogin(openbao, namespace, credential.roleId, credential.secretId);
  if (login.ok) {
    await new OpenBaoClient(openbao, { namespace, token: login.data.token }).tokenRevokeSelf();
    return "ok";
  }
  if (login.kind === "invalid" && login.status === 0) return "unreachable";
  if (login.kind === "unknown") return "unreachable";
  return "refused";
}
