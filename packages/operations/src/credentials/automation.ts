// The automation credential (Session 11, Run 11.5; P-185, P-191 to P-193,
// D-82). Like a runtime credential it is nothing in OpenBao: a row with the
// verifier of a secret. Issuing and revoking are one PostgreSQL transaction
// each, with no outcome that can be unknown.
//
// The secret is a local of `issueAutomationCredential` and of the handler
// that answers: never on an operation, an error, a log line or an audit row.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import {
  AUTOMATION_RIGHTS,
  AUTOMATION_SECRET_PREFIX,
  LIMITS,
  type AutomationRight,
  type OperationId,
  type OrganizationId,
} from "@mykey/contracts";
import {
  chainOf,
  completeOperation,
  findAutomationCredentialByOperation,
  insertAutomationCredential,
  invalidateCapture,
  lockAutomationCredential,
  revokeAutomationCredentialRow,
  withTransaction,
  type AutomationCredentialRow,
  type OperationRow,
} from "@mykey/db";
import {
  Refusal,
  admit,
  refusalOf,
  type Admission,
  type RuntimeCredentialDeps,
} from "./runtime.ts";
import { automationBinding, mintSecret, verifierOf } from "./secret.ts";

interface Common extends Admission {
  organizationId: OrganizationId;
  requestId: string;
}

export interface AutomationIssueRequest extends Common {
  name: string;
  rights: readonly AutomationRight[];
  ttlSeconds: number;
  cidrs: readonly string[];
  /** A credential of the organization whose chain the new one joins (P-193). */
  replaces?: string;
}

export interface AutomationRevokeRequest extends Common {
  credentialId: string;
}

type Refused = ReturnType<typeof refusalOf>;

export type AutomationIssueOutcome =
  | { kind: "issued"; operation: OperationRow; credential: AutomationCredentialRow; secret: string }
  | { kind: "replay"; operation: OperationRow }
  | Refused;

export type AutomationRevokeOutcome =
  | { kind: "revoked"; operation: OperationRow }
  | { kind: "replay"; operation: OperationRow }
  | Refused;

export async function issueAutomationCredential(
  deps: RuntimeCredentialDeps,
  request: AutomationIssueRequest,
): Promise<AutomationIssueOutcome> {
  const { organizationId, actor } = request;
  const operationId = randomUUID() as OperationId;
  const credentialId = randomUUID();
  // The one place the secret exists besides the answer.
  const secret = mintSecret(AUTOMATION_SECRET_PREFIX, credentialId);
  // One order, whatever order was asked for: the verifier is made over it.
  const rights = AUTOMATION_RIGHTS.filter((right) => request.rights.includes(right));
  try {
    return await withTransaction(deps.pool, async (tx) => {
      const replay = await admit(tx, deps, request, { organizationId }, operationId, {
        credentialId,
      });
      if (replay !== null) return { kind: "replay", operation: replay } as const;
      // P-193: it joins the chain of the one it replaces, whatever that one's state.
      const ownerId =
        request.replaces === undefined
          ? credentialId
          : await chainOf(tx, organizationId, request.replaces);
      if (ownerId === null) throw new Refusal("not_found");
      // Bound to its chain, its rights and its networks (D-81, D-82): a row changed later does not verify.
      const verifier = verifierOf(
        deps.verifierRing,
        secret,
        automationBinding(organizationId, ownerId, rights, request.cidrs),
      );
      await insertAutomationCredential(tx, organizationId, {
        id: credentialId,
        ownerId,
        name: request.name,
        rights,
        cidrs: request.cidrs,
        verifier: verifier.digest,
        verifierKeyId: verifier.keyId,
        ttlSeconds: request.ttlSeconds,
        issuedBy: actor.id,
        operationId,
      });
      const operation = await completeOperation(
        tx,
        operationId,
        { credentialId },
        LIMITS.operation.terminalRetentionDays,
      );
      await appendAudit(tx, {
        action: "automation_credential.issue",
        actor,
        source: "api",
        organizationId,
        target: { kind: "organization", id: organizationId },
        outcome: "success",
        requestId: request.requestId,
        operationId,
        details: {
          credentialId,
          ownerId,
          nameLength: Array.from(request.name).length,
          ttlSeconds: request.ttlSeconds,
          cidrCount: request.cidrs.length,
          projectsCreate: rights.includes("projects.create"),
          keysCreate: rights.includes("secrets.create"),
          runtimeCredentialsManage: rights.includes("runtime_credentials.manage"),
          ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
        },
      });
      const credential = await findAutomationCredentialByOperation(tx, operationId);
      if (credential === null) throw new Error("the issued automation credential was not found");
      return { kind: "issued", operation, credential, secret } as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * One transaction. From its commit every request of the credential is
 * refused (the automation routes read this row on each request). What its
 * chain made stays as it is: the projects, their secrets and their runtime
 * credentials belong to the organization.
 */
export async function revokeAutomationCredential(
  deps: RuntimeCredentialDeps,
  request: AutomationRevokeRequest,
): Promise<AutomationRevokeOutcome> {
  const { organizationId, credentialId } = request;
  const operationId = randomUUID() as OperationId;
  try {
    return await withTransaction(deps.pool, async (tx) => {
      // P-118: a revocation reduces access; while a pair is captured it records that and proceeds.
      await invalidateCapture(tx, "credential_revoke");
      const replay = await admit(tx, deps, request, { organizationId }, operationId, {
        credentialId,
      });
      if (replay !== null) return { kind: "replay", operation: replay } as const;
      const row = await lockAutomationCredential(tx, organizationId, credentialId);
      if (row === null) throw new Refusal("not_found");
      // An expired credential is still `active` in its row and can be revoked.
      if (!(await revokeAutomationCredentialRow(tx, row.id))) throw new Refusal("state_conflict");
      const operation = await completeOperation(
        tx,
        operationId,
        { credentialId, state: "revoked" },
        LIMITS.operation.terminalRetentionDays,
      );
      await appendAudit(tx, {
        action: "automation_credential.revoke",
        actor: request.actor,
        source: "api",
        organizationId,
        target: { kind: "organization", id: organizationId },
        outcome: "success",
        requestId: request.requestId,
        operationId,
        details: { credentialId },
      });
      return { kind: "revoked", operation } as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}
