// One table explains every answer that is not a success (P-136, P-140,
// FR-1.93): what happened, the safe next step, and the ids to quote. The
// text is the workspace's own, keyed by the contract's code; the server's
// message is never shown, and an uncertain outcome is never an invitation to
// send the change a second time.
import type { ErrorCode } from "@mykey/contracts";

export type Failure =
  | {
      kind: "api";
      status: number;
      code: ErrorCode;
      /** The server's text; kept for completeness, never displayed. */
      message: string;
      requestId: string | null;
      operationId: string | null;
      details: Record<string, unknown> | null;
      retryAfterSeconds: number | null;
    }
  /** Anything that is not the contract's envelope: a proxy's page, a cut connection, a body that fails its schema. */
  | { kind: "transport"; status: number | null }
  /**
   * A 202 where the screen expected the end: the server has the request and is
   * still doing it (a repeated request gets this while the first is executing).
   */
  | { kind: "unfinished"; requestId: string | null; operationId: string | null };

export interface Explanation {
  title: string;
  text: string;
  next: string;
  ids: { requestId: string | null; operationId: string | null };
}

interface Entry {
  title: string;
  /** `{action}` is replaced by what the owner was doing. */
  text: string;
  next: string;
}

const OPERATOR =
  "An operator settles this from the host (runbook reconciliation.md). Nothing on this page can.";

const ENTRIES: Readonly<Record<ErrorCode, Entry>> = Object.freeze({
  malformed_request: {
    title: "The request was not understood",
    text: "The service could not read this request. Nothing was changed.",
    next: "Reload the page and enter it once more. If it happens again, quote the request id.",
  },
  forbidden_selector: {
    title: "The request named a backend location",
    text: "A request may not name a location inside the secret store. Nothing was changed.",
    next: "Reload the page. If it happens again, quote the request id.",
  },
  mixed_authentication: {
    title: "Two kinds of sign-in were sent",
    text: "The request carried a session and a machine token together. Nothing was changed.",
    next: "Reload the page.",
  },
  unsupported_history_parameter: {
    title: "This view of the history is not supported",
    text: "The history can be read newest first only.",
    next: "Open the secret's history from its page.",
  },
  unauthenticated: {
    title: "You are not signed in",
    text: "Your session ended, or the sign-in details were not accepted.",
    next: "Sign in to continue.",
  },
  mfa_incomplete: {
    title: "The second step is missing",
    text: "This session passed the password only. The workspace opens after the authenticator code.",
    next: "Enter the code from your authenticator app.",
  },
  action_denied: {
    title: "You may not do this here",
    text: "Your role in this organization does not allow you to {action}. Nothing was changed.",
    next: "Ask an owner or an admin of the organization.",
  },
  origin_rejected: {
    title: "The request did not come from this site",
    text: "The service accepts changes only from its own pages. Nothing was changed.",
    next: "Open the workspace from its own address and do it there.",
  },
  fresh_verification_required: {
    title: "A fresh authenticator code is needed",
    text: "To {action}, the service asks for a code from your authenticator app from the last ten minutes.",
    next: "Enter a new code, then confirm the action once more.",
  },
  not_found: {
    title: "Not found",
    text: "This does not exist, or it is not visible to you. The service gives the same answer for both.",
    next: "Go back to the overview and open it from there.",
  },
  version_conflict: {
    title: "The secret changed since you opened it",
    text: "Someone saved a newer version while this form was open. Your change was not saved, and nothing was overwritten.",
    next: "Reload to see the current version, or cancel. There is no way to save over it.",
  },
  already_exists: {
    title: "That name is already in use",
    text: "Something with this name exists here already. Nothing was changed.",
    next: "Choose another name.",
  },
  state_conflict: {
    title: "Not possible in the current state",
    text: "The state of this item does not allow you to {action} right now. Nothing was changed.",
    next: "Reload to see the current state. The state says what can be done next.",
  },
  key_under_review: {
    title: "This secret is under review",
    text: "An earlier change to this secret has an outcome that is not known, so it is closed until that is settled.",
    next: OPERATOR,
  },
  environment_changed: {
    title: "The environment changed meanwhile",
    text: "A secret of this environment changed while the complete set was being read, so no set was produced.",
    next: "Start it once more when no change is in progress.",
  },
  listing_changed: {
    title: "The list changed",
    text: "The list changed while you were paging through it.",
    next: "The list is loaded again from its first page.",
  },
  idempotency_conflict: {
    title: "This request was already used for something else",
    text: "The key of this request belongs to a different earlier request. Nothing was changed by this one.",
    next: "Reload the page and enter it once more.",
  },
  replay_expired: {
    title: "The record of this request has expired",
    text: "The service no longer keeps the record of this request, so it cannot be continued.",
    next: "Look at the current state of the item, then start a new request if it is still needed.",
  },
  credential_not_replayable: {
    title: "This token cannot be shown again",
    text: "The token of this request was already delivered once, or its delivery was lost. A token is shown exactly once.",
    next: "Revoke that credential and issue a new one.",
  },
  validation_failed: {
    title: "A value is not valid",
    text: "A name or a value in this request breaks a rule. Nothing was changed.",
    next: "Correct the marked field and submit.",
  },
  precondition_required: {
    title: "The request was incomplete",
    text: "The request did not say which version it expected. Nothing was changed.",
    next: "Reload to see the current version, or cancel.",
  },
  rate_limited: {
    title: "Too many requests",
    text: "The service limits how often this may be done. This request was refused and changed nothing.",
    next: "Wait {seconds}. Waiting is all that is needed.",
  },
  busy: {
    title: "The service is busy",
    text: "The service is doing work that cannot be interrupted (for a short time during a backup, for example). This request was refused and changed nothing.",
    next: "Wait a few seconds and submit it once more.",
  },
  outcome_unknown: {
    title: "The outcome is not known",
    text: "The change was sent to the secret store and no answer came back. Whether it happened is not known: the service does not guess.",
    next: `Do not enter it a second time. Open the operation to see its state. ${OPERATOR}`,
  },
  backend_inconsistent: {
    title: "This needs review",
    text: "The service found that its records and the secret store disagree here, and has closed it until that is settled.",
    next: OPERATOR,
  },
  backend_sealed: {
    title: "The secret store is sealed",
    text: "The secret store is closed and cannot serve values. This request changed nothing.",
    next: "An operator unseals it from the host (runbook kms-and-unseal.md).",
  },
  quarantined: {
    title: "The service is not open",
    text: "The service is closed by its operator, as it is after a restore or during a deployment. Changes are refused until it is opened.",
    next: "An operator opens it from the host (runbook service-gate.md).",
  },
  audit_unavailable: {
    title: "The action could not be recorded",
    text: "The service records every sensitive action before it performs it. The record could not be written, so the action was not performed.",
    next: "Submit it once more in a minute. If the same answer comes back, close the form and start the change again. If it lasts, the operator is alerted.",
  },
  dependency_unavailable: {
    title: "A part of the service is unavailable",
    text: "Something the service needs did not answer, and this request was not completed.",
    next: "Look at the current state, then submit the same request once more in a minute. The service does not do the same request twice. If the same answer comes back, close the form and start the change again.",
  },
  capacity_exceeded: {
    title: "No room for this",
    text: "A limit of the service is reached: the environment is full, or the host is low on space. This request changed nothing.",
    next: "Remove what is no longer needed, or ask the operator about the host's space.",
  },
});

const seconds = (value: number | null): string =>
  value === null ? "a minute" : `${String(value)} ${value === 1 ? "second" : "seconds"}`;

/** What to show for a failure. `context.action` completes "… to {action}", e.g. "save the secret". */
export function explain(failure: Failure, context: { action: string }): Explanation {
  if (failure.kind === "transport") {
    return {
      title: "No usable answer came back",
      text: "The connection was cut, or something between you and the service answered in its place. Whether the request arrived is not known.",
      next: "Reload the page and look at the current state before doing anything else.",
      ids: { requestId: null, operationId: null },
    };
  }
  if (failure.kind === "unfinished") {
    return {
      title: "Not finished yet",
      text: "The service has this request and is still working on it. It is not done, and nothing says it will not be.",
      next: "Read how it ends under Operations. Do not enter it a second time.",
      ids: { requestId: failure.requestId, operationId: failure.operationId },
    };
  }
  // The service names an operation: the request was accepted before the failure, and goes on.
  if (failure.code === "dependency_unavailable" && failure.operationId !== null) {
    return {
      title: ENTRIES.dependency_unavailable.title,
      text: "Something the service needs did not answer. The request was accepted before that, and the service continues it by itself.",
      next: "Read how it ends under Operations. Do not enter it a second time.",
      ids: { requestId: failure.requestId, operationId: failure.operationId },
    };
  }
  const entry = ENTRIES[failure.code];
  return {
    title: entry.title,
    text: entry.text.replace("{action}", context.action),
    next: entry.next.replace("{seconds}", seconds(failure.retryAfterSeconds)),
    ids: { requestId: failure.requestId, operationId: failure.operationId },
  };
}
