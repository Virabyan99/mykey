// The digest of an environment's two OpenBao objects (Run 3.8), as the
// provisioner stores it in `policy_digest` and the sweep and reactivation
// (Run 5.3) recompute it. Kept apart from the provisioner's job so that the
// API reaches it without an import path to the provisioner's client.
import { createHash } from "node:crypto";
import type { EnvironmentId } from "@mykey/contracts";
import { machineTokenRole, type MachineTokenRole } from "@mykey/openbao";

/** The machine token role as OpenBao reads it back (`token_num_uses` 0 is omitted). */
export type ReadableTokenRole = Omit<MachineTokenRole, "token_num_uses">;

/** The digest of an environment's two objects, as the sweep recomputes it. */
export function policyDigest(policy: string, tokenRole: ReadableTokenRole): string {
  const fields = Object.keys(tokenRole).sort();
  const role = Object.fromEntries(
    fields.map((field) => [field, tokenRole[field as keyof ReadableTokenRole]]),
  );
  return createHash("sha256")
    .update(JSON.stringify({ policy, tokenRole: role }))
    .digest("hex");
}

/** The machine token role as OpenBao reads it back (`token_num_uses` 0 is omitted). */
export function readableRole(environmentId: EnvironmentId): ReadableTokenRole {
  const role: Partial<ReturnType<typeof machineTokenRole>> = machineTokenRole(environmentId);
  delete role.token_num_uses;
  return role as ReadableTokenRole;
}
