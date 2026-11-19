// The one way an audit event is written (Doc 10 §4.1 rule 8: no audit, no
// action). The event is validated before any SQL; a failed insert throws
// AuditUnavailable, which the caller turns into `503 audit_unavailable` and
// does not perform the action. Given a transaction's client, the row is part
// of that transaction.
import { randomUUID } from "node:crypto";
import type { Queryable } from "@mykey/db";
import {
  ACCOUNT_WITHOUT_ORGANIZATION,
  AUDIT_DETAILS,
  AUDIT_SCOPE,
  auditEnvelopeSchema,
  type AuditEvent,
} from "./events.ts";

/** The audit row could not be written. Carries no detail of the event. */
export class AuditUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super("the audit event could not be written", options);
    this.name = "AuditUnavailable";
  }
}

/** A refused event. The message names the part, never a value. */
export class AuditEventInvalid extends Error {
  constructor(part: "action" | "event" | "details") {
    super(`the audit ${part} is invalid`);
    this.name = "AuditEventInvalid";
  }
}

function validate(event: AuditEvent): void {
  const action = (event as { action: unknown }).action;
  if (typeof action !== "string" || !Object.hasOwn(AUDIT_DETAILS, action)) {
    throw new AuditEventInvalid("action");
  }
  if (!auditEnvelopeSchema.safeParse(event).success) throw new AuditEventInvalid("event");
  // P-106: the organization fits the action's scope.
  const scope = AUDIT_SCOPE[event.action];
  const withOrganization = event.organizationId !== null;
  const fits =
    scope === "tenant"
      ? withOrganization || ACCOUNT_WITHOUT_ORGANIZATION.has(event.action)
      : !withOrganization;
  if (!fits) throw new AuditEventInvalid("event");
  if (!AUDIT_DETAILS[event.action].safeParse(event.details).success) {
    throw new AuditEventInvalid("details");
  }
}

/** Writes one event and returns its id. */
export async function appendAudit(db: Queryable, event: AuditEvent): Promise<string> {
  validate(event);
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO audit.event
         (id, actor_kind, actor_id, source_category, organization_id, action, target_kind,
          target_id, outcome, request_id, operation_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        event.actor.kind,
        event.actor.id,
        event.source,
        event.organizationId,
        event.action,
        event.target?.kind ?? null,
        event.target?.id ?? null,
        event.outcome,
        event.requestId,
        event.operationId,
        JSON.stringify(event.details),
      ],
    );
  } catch (error) {
    throw new AuditUnavailable({ cause: error });
  }
  return id;
}
