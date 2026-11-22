// What every page of the workspace says it is for (P-159, FR-1.102). One
// entry per WEB_ROUTES id: its title, one sentence of what it is for, the
// points of "How this works", the help article that explains it, and the
// hint beside its primary action. Plain English, sentence case, second
// person, the product's own terms. Every sentence here is a claim: the claims
// walk reads this file (docs/evidence/session-9/claims.md), and
// tests/unit/web/copy.test.ts keeps it complete and free of what no text may hold.
import { LIMITS } from "@mykey/contracts";

export interface PageCopy {
  title: string;
  summary: string;
  how: readonly string[];
  help: string;
  /** What the primary action does, in one line; empty when the page has none. */
  action: string;
}

const REVEAL_SECONDS = LIMITS.reveal.displayMaxSeconds;
const VERSIONS = LIMITS.secret.versionsKept;
const TOKEN_DAYS = Math.floor(LIMITS.machineToken.maxTtlSeconds / 86_400);
const CODES = LIMITS.recovery.codeCount;

export const PAGES = {
  home: {
    title: "Organizations",
    summary: "The organizations this account belongs to; open one to see its projects.",
    how: [
      "An organization is created by an operator from the host; the workspace cannot create one.",
      "With one organization, the workspace opens it for you.",
    ],
    help: "getting-started",
    action: "",
  },
  "sign-in": {
    title: "Sign in",
    summary: "Sign in with your e-mail and password, then a code from your authenticator app.",
    how: [
      "There is no sign-up: the first account is created by an operator.",
      "After five failed sign-ins, the account refuses new attempts for 15 minutes.",
      "Lost your authenticator or your password? Ask your operator for a reset link.",
    ],
    help: "sign-in-help",
    action: "",
  },
  enroll: {
    title: "Set up your authenticator",
    summary:
      "Connect an authenticator app to this account, so that every sign-in needs a code from it.",
    how: [
      "An authenticator app (on your phone or computer) shows a new six-digit code every 30 seconds.",
      "You can type the setup key into the app by hand; there is no QR code.",
      `After the first code is accepted you get ${String(CODES)} recovery codes. Keep them somewhere safe and offline.`,
    ],
    help: "authenticator",
    action: "",
  },
  reset: {
    title: "Reset your account",
    summary:
      "Set a new password, and a new authenticator if yours is lost, with the single-use link your operator gave you.",
    how: [
      "The link comes from your operator, works once, and expires after 15 minutes.",
      "When the operator issues the link, every session of the account ends.",
    ],
    help: "lost-authenticator",
    action: "",
  },
  account: {
    title: "Account",
    summary: "Your password, your recovery codes and the sessions signed in to this account.",
    how: [
      "Changing the password needs a recent code from your authenticator and ends your other sessions. This one stays signed in.",
      `Recovery codes can be replaced, never shown again: the ${String(CODES)} new ones replace every old one.`,
      "A session ends after 30 minutes without use, and after 12 hours in any case.",
    ],
    help: "account",
    action: "",
  },
  help: {
    title: "Help centre",
    summary:
      "Answers to the questions owners ask, searchable, with links to the screens they name.",
    how: [
      "Search looks at titles, keywords, summaries and text of the articles in this page; nothing is sent anywhere.",
      "Operator procedures are runbooks in the repository, listed at the end.",
    ],
    help: "getting-started",
    action: "",
  },
  "help-article": {
    title: "Help",
    summary: "One answer of the help centre.",
    how: [
      "Each article answers one question, and links to the screens it names.",
      "Related articles are listed at the end; Help centre has them all.",
    ],
    help: "getting-started",
    action: "",
  },
  overview: {
    title: "Home",
    summary: "Your projects, their environments and what to do next.",
    how: [
      "A project groups the environments of one application, such as development and production.",
      "Key counts are counts of names from the index; no value is read for this page.",
      "Owners and admins see counts and the summary; members see the projects they can open.",
    ],
    help: "getting-started",
    action:
      "Create a project for an application. Its first environment, development, is made for you.",
  },
  activity: {
    title: "Activity",
    summary:
      "What people and machines did in this organization in the last 30 days, one line per operation.",
    how: [
      "Each line says who did what, where, and how it ended.",
      "A change that is still running is shown with its operation's state when the page read it. Operations follows it until it ends.",
      "Audit has every recorded event; Operations has the changes of one environment.",
    ],
    help: "activity-audit-operations",
    action: "",
  },
  audit: {
    title: "Audit",
    summary: "Every recorded event of this organization and its outcome, for checking.",
    how: [
      "Filter by day, action, outcome, actor, place, operation or request; without a window it shows the last 30 days.",
      "Audit events are kept for 365 days and copied to locked storage.",
      "Activity shows the same events of the last 30 days, one line per operation.",
    ],
    help: "activity-audit-operations",
    action: "",
  },
  project: {
    title: "Project",
    summary: "One project and its environments: add, rename, archive and reactivate.",
    how: [
      "An environment is one set of secrets, such as development or production, read by its own machine credentials.",
      "Archiving revokes the machine credentials of what is archived. Secrets and history stay readable.",
      "A new environment is pending until the server says active.",
    ],
    help: "projects-environments",
    action: "Add an environment, such as staging or production.",
  },
  secrets: {
    title: "Secrets",
    summary:
      "The configuration values this environment gives to your application, such as API keys and passwords.",
    how: [
      `Values stay hidden in lists. Open a secret to reveal its value for ${String(REVEAL_SECONDS)} seconds.`,
      `Every new value makes a new version. The last ${String(VERSIONS)} stay in the history and can be restored.`,
      "Your application reads the whole set at start through the CLI. If any part cannot be read, it does not start.",
    ],
    help: "secrets-basics",
    action: "Add a secret by name and value, or import a .env file.",
  },
  secret: {
    title: "Secret",
    summary: "One secret: its value on request, its versions and its history.",
    how: [
      `Reveal shows the value for ${String(REVEAL_SECONDS)} seconds, and hides it when you leave the page or the tab.`,
      "Every reveal is recorded with the secret's name: Audit shows who revealed which secret, and when.",
      `The last ${String(VERSIONS)} versions are kept. Restoring one writes its value as a new version.`,
    ],
    help: "versions-restore",
    action: "Change the value: the old one stays in the history.",
  },
  import: {
    title: "Import and export",
    summary: "Bring secrets in from a .env file, or write this environment's live values into one.",
    how: [
      "An import shows a preview of what would change before anything is written.",
      "An export is a plain-text file of every live value. Keep it as you would the secrets themselves.",
      "An export needs a recent code from your authenticator. Imports and exports are both recorded.",
    ],
    help: "add-secrets",
    action: "Choose a .env file to see what it would change.",
  },
  credentials: {
    title: "Machine credentials",
    summary: "Tokens that let one machine read this environment's secrets, and nothing else.",
    how: [
      "A token is shown once, when it is issued. MyKey keeps no copy.",
      "A token cannot be renewed. To replace one, issue a new token, switch the machine to it, then revoke the old one.",
      "Revoking is final: the machine's next start is refused.",
      `A token lasts at most ${String(TOKEN_DAYS)} days.`,
    ],
    help: "machine-credentials",
    action: "Issue a credential for the machine that runs your application.",
  },
  operations: {
    title: "Operations",
    summary: "Changes the service carried out for this environment, and their state.",
    how: [
      "Every change of this environment is listed here, newest first. Most end at once; the page follows one that is still running until it ends.",
      "An uncertain operation is never repeated by the page: an operator checks it and settles it.",
      "Nothing on this page sends a change.",
    ],
    help: "uncertain",
    action: "",
  },
  connect: {
    title: "Connect an application",
    summary:
      "The commands that start your application with this environment's secrets, with the ids filled in.",
    how: [
      "The CLI reads the complete set at start and passes it to your application as environment variables.",
      "The token is never filled in here: you issue it under Machine credentials and type it into a file.",
      "The commands are the runbook's own (consumer-local.md and consumer-deploy.md).",
    ],
    help: "connect-app",
    action: "",
  },
} as const satisfies Record<string, PageCopy>;

export type PageId = keyof typeof PAGES;

export function pageCopy(id: string): PageCopy {
  return (PAGES as Record<string, PageCopy | undefined>)[id] ?? PAGES["help-article"];
}
