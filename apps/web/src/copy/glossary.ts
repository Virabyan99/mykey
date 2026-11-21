// The workspace's words (P-159, Doc 03 §6.1: one vocabulary across the page,
// the API, the CLI and the runbooks). A `Term` in a sentence shows the
// definition; the help article "Glossary" is made from this list.
export interface GlossaryEntry {
  term: string;
  definition: string;
  /** The help article that explains it. */
  article: string;
}

export const GLOSSARY = {
  organization: {
    term: "Organization",
    definition:
      "The top of the workspace: its members, projects and audit. An operator creates it from the host; it has an id and no name.",
    article: "getting-started",
  },
  project: {
    term: "Project",
    definition: "The environments of one application, grouped under one name.",
    article: "projects-environments",
  },
  environment: {
    term: "Environment",
    definition:
      "One set of secrets of a project, such as development or production, read by its own machine credentials.",
    article: "projects-environments",
  },
  secret: {
    term: "Secret",
    definition:
      "A named configuration value, such as an API key, that your application receives as an environment variable.",
    article: "secrets-basics",
  },
  version: {
    term: "Version",
    definition:
      "Each change of a secret's value makes a new version. The last 20 are kept and can be restored.",
    article: "versions-restore",
  },
  "machine-credential": {
    term: "Machine credential",
    definition:
      "The record of a token that lets one machine read one environment's secrets: its name, state, expiry and last use.",
    article: "machine-credentials",
  },
  token: {
    term: "Token",
    definition:
      "The secret string a machine presents to read its environment. It is shown once, when it is issued.",
    article: "machine-credentials",
  },
  operation: {
    term: "Operation",
    definition:
      "A change the service carries out in the secret store, with a state of its own until it ends.",
    article: "activity-audit-operations",
  },
  uncertain: {
    term: "Uncertain",
    definition:
      "An operation MyKey sent but could not confirm. It is never repeated by the page; an operator settles it.",
    article: "uncertain",
  },
  "needs-review": {
    term: "Needs review",
    definition:
      "The server could not confirm a state in the secret store. Nothing can change it until an operator settles it.",
    article: "needs-review",
  },
  activity: {
    term: "Activity",
    definition: "What people and machines did, in plain words, newest first.",
    article: "activity-audit-operations",
  },
  "audit-event": {
    term: "Audit event",
    definition: "One recorded event with its actor, its target and its outcome, kept for 365 days.",
    article: "activity-audit-operations",
  },
  "import-preview": {
    term: "Import preview",
    definition:
      "What a .env file would add, change or leave alone, shown before anything is written. It lasts 15 minutes.",
    article: "add-secrets",
  },
  export: {
    term: "Export",
    definition: "A plain-text .env file of every live value of one environment.",
    article: "export-risks",
  },
  "re-verification": {
    term: "Re-verification",
    definition:
      "A new code from your authenticator, asked before an export, an issued token or new recovery codes when the last one is older than 10 minutes.",
    article: "re-verification",
  },
  "recovery-code": {
    term: "Recovery code",
    definition:
      "One of ten single-use codes that sign you in when you do not have your authenticator.",
    article: "lost-authenticator",
  },
  authenticator: {
    term: "Authenticator",
    definition:
      "An app on your phone or computer that shows a new six-digit code every 30 seconds.",
    article: "authenticator",
  },
  "service-gate": {
    term: "Service gate",
    definition:
      "The switch an operator uses to open or close the service. While it is closed, the service refuses the requests of the workspace and of machines.",
    article: "service-gate",
  },
  sealed: {
    term: "Sealed",
    definition: "The secret store is locked and can read nothing until it is unsealed on the host.",
    article: "sealed",
  },
  operator: {
    term: "Operator",
    definition:
      "The person who runs the service on its host: accounts, organizations, restores and the gate.",
    article: "getting-started",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;
