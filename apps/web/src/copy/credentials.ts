// The words of the two kinds of machine credential and of the automation
// credential (Session 11, Run 11.6; D-81, D-82). Every sentence here is a
// claim: tests/unit/web/claims.test.ts holds the ones that are easy to
// overstate, and copy.test.ts lints all of it. The numbers are the contract's.
import { LIMITS, type AutomationRight } from "@mykey/contracts";

const DAY_SECONDS = 86_400;
const TOKEN_DAYS = Math.floor(LIMITS.machineToken.maxTtlSeconds / DAY_SECONDS);
const EXCHANGE_MINUTES = LIMITS.runtimeCredential.exchangeTtlSeconds / 60;

export const CREDENTIAL_COPY = {
  /** The choice the issue form opens with: a label and one sentence each. */
  kinds: {
    token: {
      label: `A ${String(TOKEN_DAYS)}-day token`,
      text: "For a workstation or a job a person restarts.",
      word: `${String(TOKEN_DAYS)}-day token`,
    },
    runtime: {
      label: "A runtime credential",
      text: "For a server that must start by itself for up to a year.",
      word: "runtime credential",
    },
  },
  runtime: {
    how: `The CLI exchanges the client secret at every start for a token of ${String(EXCHANGE_MINUTES)} minutes, and reads the secrets with that.`,
    once: "It cannot be shown again: MyKey keeps a keyed digest of it, never the secret. Put it where its server reads it now, the same way a token is stored.",
    gone: "The client secret is no longer shown, and it cannot be shown again. If it did not reach its server, revoke this credential and issue a new one.",
    anywhere: "from any network",
  },
  automation: {
    intro:
      "An automation credential lets a script create projects, environments and secrets, and issue runtime credentials for them. No route lets it read, change or delete a secret.",
    once: "It cannot be shown again: MyKey keeps a keyed digest of it, never the secret. Put it into a file only your script can read.",
    gone: "The secret is no longer shown, and it cannot be shown again. If it did not reach its place, revoke this credential and issue one that replaces it.",
    replaces:
      "A credential that replaces another manages the same projects. Both work until you revoke the older one: this is how a secret is rotated, and how a script gets its projects back after a restore.",
    alone: "None: it starts with no project",
    managed: "Managed by automation",
  },
  /** The three rights (D-82), in the contract's order. */
  rights: {
    "projects.create": {
      label: "Create projects and environments",
      text: "It may create projects, and environments in the projects its chain manages.",
    },
    "secrets.create": {
      label: "Create secrets",
      text: "It may write new names into those environments. It cannot change, delete or read one.",
    },
    "runtime_credentials.manage": {
      label: "Manage runtime credentials",
      text: "It may issue, list and revoke runtime credentials there. A runtime credential it issues reads the values of its environment.",
    },
  } satisfies Record<AutomationRight, { label: string; text: string }>,
  /** Connect an application: when to choose which. */
  choose: `A ${String(TOKEN_DAYS)}-day token suits a workstation or a job a person restarts. A runtime credential suits a server that must start by itself for up to a year. The step that stores it is the same for both: the CLI tells the two apart.`,
} as const;
