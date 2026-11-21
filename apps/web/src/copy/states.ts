// What every state means and what to do about it (P-159, FR-1.96): one entry
// per state of every kind in labels.ts. A badge shows it on focus and on
// hover; the help article "What does each state mean?" is made from it.
import type { StateKind } from "../labels.ts";

export interface StateCopy {
  meaning: string;
  next: string;
}

const OPERATOR = "An operator checks it on the host and settles it. Nothing on the page can.";

export const STATES = {
  resource: {
    pending: {
      meaning: "The server is still preparing it in the secret store.",
      next: "Wait: the page asks again by itself. Nothing can be written until it is active.",
    },
    active: {
      meaning: "Ready: it can be read and written.",
      next: "Nothing to do.",
    },
    revoking: {
      meaning: "It is being archived: its machine credentials are being revoked.",
      next: "Wait until it says archived. Nothing can be written meanwhile.",
    },
    archived: {
      meaning:
        "Archived: its secrets and their history can still be read, and nothing can be written.",
      next: "Reactivate it on the project's page to write again. Revoked credentials stay revoked.",
    },
    needs_review: {
      meaning: "The server could not confirm its state in the secret store.",
      next: OPERATOR,
    },
  },
  index: {
    live: {
      meaning: "The secret has a current value that your application reads.",
      next: "Nothing to do.",
    },
    deleted: {
      meaning: "The secret has no current value: nobody and no machine can read it.",
      next: "Undelete it from its page while its version is still kept, or leave it.",
    },
    needs_review: {
      meaning: "The server could not confirm this secret's latest change in the secret store.",
      next: OPERATOR,
    },
  },
  credential: {
    issuing: {
      meaning: "The server is issuing the token.",
      next: "Wait: the token is shown once when it is ready.",
    },
    active: {
      meaning: "The token is accepted until it expires or is revoked.",
      next: "Nothing to do. Replace it before it expires.",
    },
    revoking: {
      meaning: "The revocation was sent and its end has not been confirmed.",
      next: "Treat the token as still accepted until this says revoked. An operator settles it.",
    },
    revoked: {
      meaning: "The token is refused. This cannot be undone.",
      next: "To give the machine access again, issue a new credential.",
    },
    expired: {
      meaning: "The token is past its lifetime and is refused.",
      next: "Issue a new credential and store it on the machine.",
    },
    needs_review: {
      meaning: "Whether a token exists for this credential is not known.",
      next: OPERATOR,
    },
  },
  operation: {
    accepted: {
      meaning: "The server has the change and has not started it yet.",
      next: "Wait: the page asks again by itself.",
    },
    executing: {
      meaning: "The server is carrying out the change.",
      next: "Wait: the page asks again by itself.",
    },
    awaiting_input: {
      meaning:
        "An import stopped before the end of its file and waits for it. What was written stays written.",
      next: "Resume it on the import screen. Only the member who started it can.",
    },
    uncertain: {
      meaning: "MyKey sent the change, but could not confirm whether it took effect.",
      next: "Do not repeat the change. An operator checks it on the host and settles it.",
    },
    succeeded: {
      meaning: "The change took effect.",
      next: "Nothing to do.",
    },
    partial: {
      meaning: "Some entries of an import were written and some were not.",
      next: "Import the same file again: the preview shows what is still missing.",
    },
    rejected: {
      meaning: "The server refused the change. Nothing was changed.",
      next: "Read the reason in the operation's details, correct what it names, and try again.",
    },
  },
  organization: {
    provisioning: {
      meaning: "The operator is preparing the organization in the secret store.",
      next: "Wait for the operator to finish.",
    },
    active: {
      meaning: "Ready for use.",
      next: "Nothing to do.",
    },
    failed: {
      meaning: "Preparing the organization did not finish.",
      next: "Ask your operator: provisioning is run again from the host.",
    },
    needs_review: {
      meaning: "The server could not confirm the organization's state in the secret store.",
      next: OPERATOR,
    },
  },
} as const satisfies Record<StateKind, Record<string, StateCopy>>;

/** The meaning of one state, or that the page does not know it. */
export function stateCopy(kind: StateKind, state: string): StateCopy {
  const known = (STATES[kind] as Record<string, StateCopy | undefined>)[state];
  return (
    known ?? {
      meaning: "A state this page does not know.",
      next: "Reload the page. If it stays, quote the request id to your operator.",
    }
  );
}

/** The names of the kinds, as the help article says them. */
export const KIND_NAMES: Readonly<Record<StateKind, string>> = {
  resource: "Projects and environments",
  index: "Secrets",
  credential: "Machine credentials",
  operation: "Operations",
  organization: "Organizations",
};
