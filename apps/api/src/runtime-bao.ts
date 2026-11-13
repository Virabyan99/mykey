// The runtime credential as the host delivers it (Run 3.8): three files in the
// API's secrets directory. Read on each call until all three exist, then kept
// (Run 4.2, P-62). The values never leave this module but in the client.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { organizationIdSchema, type OrganizationId } from "@mykey/contracts";
import { OpenBaoClient, namespaceFor, type OpenBaoTarget } from "@mykey/openbao";
import type { RuntimeBao } from "@mykey/operations";

interface Credential {
  organizationId: OrganizationId;
  client: OpenBaoClient;
}

function readCredential(target: OpenBaoTarget, directory: string): Credential | null {
  try {
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    const organizationId = organizationIdSchema.safeParse(read("organization-id"));
    if (!organizationId.success) return null;
    const roleId = read("runtime-role-id");
    const secretId = read("runtime-secret-id");
    if (roleId === "" || secretId === "") return null;
    return {
      organizationId: organizationId.data,
      client: new OpenBaoClient(target, {
        namespace: namespaceFor(organizationId.data),
        auth: { inline: { roleId, secretId } },
      }),
    };
  } catch {
    return null;
  }
}

export function runtimeBaoFromDirectory(target: OpenBaoTarget, directory: string): RuntimeBao {
  let credential: Credential | null = null;
  return {
    clientFor(organizationId) {
      credential ??= readCredential(target, directory);
      return credential?.organizationId === organizationId ? credential.client : null;
    },
  };
}
