// The help centre's articles (P-159, Task F): structured data, rendered by
// help/Article.tsx without a Markdown library and without markup from text.
// Each article answers one question owners ask, in the product's own words,
// and is checked against the runbook it summarizes. Four are generated from
// the catalogue itself (states, errors, glossary, known limits), so they
// cannot drift from what the page shows. Every text here is linted
// (copy/lint.ts) and walked for claims.
import { LIMITS } from "@mykey/contracts";

export type Category =
  | "getting-started"
  | "secrets"
  | "import-export"
  | "credentials"
  | "activity"
  | "account"
  | "trouble"
  | "limits"
  | "reference";

export const CATEGORIES: readonly { id: Category; title: string }[] = [
  { id: "getting-started", title: "Getting started" },
  { id: "secrets", title: "Secrets and versions" },
  { id: "import-export", title: "Import and export" },
  { id: "credentials", title: "Machine credentials and the CLI" },
  { id: "activity", title: "Activity, audit and operations" },
  { id: "account", title: "Account and sign-in" },
  { id: "trouble", title: "When something goes wrong" },
  { id: "limits", title: "Known limits" },
  { id: "reference", title: "Reference and glossary" },
];

/** A screen the article sends the owner to: an id of WEB_ROUTES. */
export type ScreenId =
  | "overview"
  | "project"
  | "secrets"
  | "import"
  | "credentials"
  | "operations"
  | "connect"
  | "activity"
  | "audit"
  | "account"
  | "help";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "steps"; items: readonly string[] }
  | { kind: "list"; items: readonly string[] }
  | { kind: "callout"; text: string; tone?: "info" | "warning" }
  | { kind: "code"; text: string }
  | { kind: "screen"; screen: ScreenId; text: string }
  | {
      kind: "generated";
      what: "states" | "errors" | "glossary" | "known-limits" | "cli-exit-codes";
    }
  | { kind: "external"; href: "/v1/reference"; text: string };

export interface Article {
  id: string;
  title: string;
  summary: string;
  category: Category;
  keywords: readonly string[];
  blocks: readonly Block[];
  related: readonly string[];
  /** Shown under "Popular questions" on the help centre's first page. */
  popular?: boolean;
}

const p = (text: string): Block => ({ kind: "p", text });
const steps = (...items: string[]): Block => ({ kind: "steps", items });
const list = (...items: string[]): Block => ({ kind: "list", items });
const note = (text: string, tone: "info" | "warning" = "info"): Block => ({
  kind: "callout",
  text,
  tone,
});
const screen = (to: ScreenId, text: string): Block => ({ kind: "screen", screen: to, text });

const REVEAL = String(LIMITS.reveal.displayMaxSeconds);
const VERSIONS = String(LIMITS.secret.versionsKept);
const TOKEN_DAYS = String(Math.floor(LIMITS.machineToken.maxTtlSeconds / 86_400));
const CODES = String(LIMITS.recovery.codeCount);
const FRESH_MINUTES = String(LIMITS.session.freshTotpSeconds / 60);
const IMPORT_MIB = String(LIMITS.body.dotenvMaxBytes / 1_048_576);

/** The CLI's exit codes (apps/cli/src/errors.ts); tests/unit/web/help-search.test.ts keeps them equal. */
export const CLI_EXIT_CODES: readonly { code: number; category: string; meaning: string }[] = [
  {
    code: 0,
    category: "ok",
    meaning:
      "The command did what it was asked. Once secrets run has started the application, the exit code is the application's own.",
  },
  {
    code: 64,
    category: "usage",
    meaning:
      "The command line or a setting is not one the CLI accepts, the command to start cannot be found, or a secret's name is already set in the environment (without --override).",
  },
  {
    code: 65,
    category: "malformed",
    meaning: "An answer of the service could not be read as the service's own.",
  },
  {
    code: 69,
    category: "unavailable",
    meaning:
      "The service could not be reached, did not answer in time, or cannot give the complete set now. Nothing was started.",
  },
  {
    code: 73,
    category: "export_target",
    meaning: "The export's file cannot be written where it was asked.",
  },
  {
    code: 75,
    category: "capacity",
    meaning:
      "Too many requests, the service is full or busy, or the set is too large for this platform.",
  },
  {
    code: 76,
    category: "incompatible",
    meaning: "The CLI and the service do not speak the same version of the API.",
  },
  {
    code: 77,
    category: "denied",
    meaning:
      "The token is not accepted: revoked, expired, mistyped, or for another environment or project.",
  },
  {
    code: 78,
    category: "unsupported",
    meaning: "This platform or configuration is not supported.",
  },
];

export const ARTICLES: readonly Article[] = [
  {
    id: "getting-started",
    title: "Getting started",
    summary:
      "From an empty workspace to an application that starts with its secrets, in six steps.",
    category: "getting-started",
    keywords: ["start", "first", "begin", "setup", "checklist", "new"],
    popular: true,
    blocks: [
      p("Home shows the same six steps as a checklist, with what is already done."),
      steps(
        "Create a project on Home. Its first environment, development, is made for you; both are pending until the server says active.",
        "Add your secrets under Secrets, one by one, or import a .env file under Import and export.",
        "Issue a machine credential under Machine credentials. Its token is shown once: copy it then.",
        "Install the CLI on the machine that runs your application. Connect an application shows the commands with your ids filled in.",
        "Store the token in a file only you can read, and start your application through the CLI.",
        "See what happened under Activity: the issued credential, and the machine's first read.",
      ),
      screen("overview", "Go to Home"),
      screen("connect", "Go to Connect an application"),
    ],
    related: ["connect-app", "add-secrets", "machine-credentials"],
  },
  {
    id: "project-id",
    title: "Where do I find my project's id?",
    summary: "On every screen of the project, beside its name, with a button that copies it.",
    category: "getting-started",
    keywords: ["project id", "id", "copy", "identifier", "uuid", "SECRETS_PROJECT"],
    popular: true,
    blocks: [
      p(
        "The project's id is shown under the title of the project's page and of each of its environment screens, and in the breadcrumbs at the top. Copy project id puts exactly the id on the clipboard.",
      ),
      p(
        "The CLI needs it as SECRETS_PROJECT. It is the project's id, not the organization's and not the environment's: either of those answers denied with code not_found.",
      ),
      p("Connect an application fills the project's id into its commands for you."),
      screen("connect", "Go to Connect an application"),
    ],
    related: ["connect-app", "projects-environments"],
  },
  {
    id: "connect-app",
    title: "How do I connect my application?",
    summary:
      "Install the CLI, store a token, and start the application through the CLI. Connect an application shows each command.",
    category: "credentials",
    keywords: [
      "connect",
      "application",
      "app",
      "cli",
      "install",
      "start",
      "run",
      "secrets run",
      "consumer",
    ],
    popular: true,
    blocks: [
      p(
        "Your application does not read a .env file. The CLI reads the complete set of one environment at start and starts the application with the secrets as environment variables. If the complete set cannot be read, nothing starts.",
      ),
      steps(
        "Open the environment, then Connect an application. Its commands hold this page's address, the project's id and the environment's name.",
        "Download the CLI and check its sums, then install it. The installer checks the CLI and the Node runtime it downloads against pinned sums, and needs no root.",
        "Issue a machine credential for the environment, and copy the token.",
        "Store the token with the command shown, typed on standard input into a file only you can read.",
        "Start the application through secrets-launch.sh.",
        "Check Machine credentials: Last used shows the machine's read. Activity lists it as machine.resolve.",
      ),
      note(
        "The pasted token stays on the terminal's screen. Type stty -echo before storing it, and stty echo after, to keep it off the screen.",
        "warning",
      ),
      screen("connect", "Go to Connect an application"),
    ],
    related: ["machine-credentials", "rotate-token", "cli-exit-codes"],
  },
  {
    id: "secrets-basics",
    title: "Secrets: the basics",
    summary:
      "A secret is a named value, such as an API key, that your application receives as an environment variable.",
    category: "secrets",
    keywords: ["secret", "value", "name", "add", "create", "list", "environment variable"],
    blocks: [
      p(
        "Each environment holds its own secrets. A name is upper-case letters, digits and underscores, starting with a letter, and does not start with SECRETS_.",
      ),
      list(
        "Values stay hidden in lists. Open a secret and press Reveal to see its value.",
        `A revealed value disappears after ${REVEAL} seconds, when you leave the page, or when you switch tabs.`,
        "Every new value makes a new version. The history shows who wrote each version, and when.",
        "Your application reads the whole set at start through the CLI, never one secret at a time.",
      ),
      screen("secrets", "Go to Secrets"),
    ],
    related: ["add-secrets", "values-hidden", "versions-restore"],
  },
  {
    id: "add-secrets",
    title: "How do I add or import secrets?",
    summary:
      "One at a time with New secret, or many at once from a .env file with a preview first.",
    category: "import-export",
    keywords: ["add", "new", "create", "import", "dotenv", ".env", "upload", "file", "preview"],
    popular: true,
    blocks: [
      p(
        "To add one: on Secrets, press New secret, type the name and the value, and press Create secret.",
      ),
      p(
        "To add many: on Import and export, choose a .env file. The preview lists what would be added, changed or left alone, without showing any value. Nothing is written until you apply it.",
      ),
      list(
        `A file can be at most ${IMPORT_MIB} MiB with at most 1000 entries.`,
        "A preview lasts 15 minutes; after that, choose the file again.",
        "If an import stops part way, the operation waits: press Resume on Import and export and choose the same file to write what is missing.",
      ),
      screen("import", "Go to Import and export"),
    ],
    related: ["secrets-basics", "export-risks"],
  },
  {
    id: "values-hidden",
    title: "Why can't I see a secret's value in the list?",
    summary:
      "Lists never hold values. A value is shown only on the secret's own page, on request, for a short time.",
    category: "secrets",
    keywords: ["value", "hidden", "show", "see", "masked", "reveal", "list"],
    blocks: [
      p(
        `The secrets list shows names, states, versions and times. To see a value, open the secret and press Reveal: the value is shown for ${REVEAL} seconds and is then forgotten by the page.`,
      ),
      p(
        "Every reveal is recorded, and Audit shows who revealed which secret. The page keeps no value anywhere: not in the browser's storage, not in its history, not in its search.",
      ),
      screen("secrets", "Go to Secrets"),
    ],
    related: ["secrets-basics", "activity-audit-operations"],
  },
  {
    id: "versions-restore",
    title: "How do versions and restore work?",
    summary: `Every new value makes a new version. The last ${VERSIONS} are kept, and any of them that is not deleted can be written back as a new version.`,
    category: "secrets",
    keywords: [
      "version",
      "history",
      "restore",
      "undo",
      "rollback",
      "previous",
      "old value",
      "delete",
      "undelete",
    ],
    blocks: [
      p("A secret's page lists its versions in History: who made each one, and when."),
      list(
        `Restore writes the value of an older version as a new version. Nothing is deleted, but as with every new version only the last ${VERSIONS} stay in the history.`,
        "Delete makes the current version unreadable, by people and by machines. No older version takes its place.",
        `Undelete makes a deleted version current again, while it is among the last ${VERSIONS} versions.`,
        "Each of these asks you to type the secret's name to confirm.",
      ),
      note(
        "If someone changed the secret since you opened it, the page refuses your change and offers to reload.",
      ),
    ],
    related: ["secrets-basics", "states"],
  },
  {
    id: "projects-environments",
    title: "Projects and environments",
    summary:
      "A project is one application; its environments are its separate sets of secrets, such as development and production.",
    category: "getting-started",
    keywords: [
      "project",
      "environment",
      "archive",
      "rename",
      "reactivate",
      "staging",
      "production",
      "development",
    ],
    blocks: [
      p(
        "A new project comes with one environment, development. Add others on the project's page. An environment name is lower-case letters, digits and hyphens, starting with a letter.",
      ),
      list(
        "Each environment has its own secrets and its own machine credentials. A token of one environment cannot read another.",
        "Archiving revokes every active machine credential of what is archived. Its secrets and their history stay readable.",
        "Reactivating opens it for writes again. Revoked credentials stay revoked: each machine needs a new one.",
      ),
      screen("overview", "Go to Home"),
    ],
    related: ["project-id", "machine-credentials"],
  },
  {
    id: "machine-credentials",
    title: "Machine credentials and tokens",
    summary:
      "A machine credential is a token that lets one machine read one environment, shown once and never stored by MyKey.",
    category: "credentials",
    keywords: ["credential", "token", "machine", "issue", "expiry", "expire", "last used"],
    blocks: [
      list(
        "Issue one per machine, with a name that says which machine it is.",
        "The token is shown once, when it is issued. MyKey keeps no copy and cannot show it again.",
        `A token lasts at most ${TOKEN_DAYS} days and cannot be renewed. Home lists those that expire within 7 days.`,
        "Issuing needs a recent code from your authenticator.",
        "Last used is the last time the service saw the token, to the minute. Not known means there is no record of a use, not that there was none.",
      ),
      screen("credentials", "Go to Machine credentials"),
    ],
    related: ["rotate-token", "revoke-credential", "connect-app"],
  },
  {
    id: "rotate-token",
    title: "How do I rotate a token?",
    summary:
      "Issue a new token, switch the machine to it, check it works, then revoke the old one.",
    category: "credentials",
    keywords: ["rotate", "replace", "renew", "new token", "rotation", "expiring"],
    popular: true,
    blocks: [
      steps(
        "Issue a second machine credential for the same environment, and copy its token.",
        "On the machine, replace the token file in place with the same command you stored it with.",
        "Restart the application through the CLI.",
        "Check that it started, and that Last used of the new credential on Machine credentials shows the read.",
        "Revoke the old credential. From then on it is refused (the CLI exits 77).",
      ),
      screen("credentials", "Go to Machine credentials"),
    ],
    related: ["machine-credentials", "revoke-credential"],
  },
  {
    id: "revoke-credential",
    title: "What happens when I revoke a credential?",
    summary: "Its token is refused from the moment the server answers. This cannot be undone.",
    category: "credentials",
    keywords: ["revoke", "revoked", "remove", "disable", "block", "credential"],
    blocks: [
      p(
        "A machine that still uses the token can no longer read its secrets: its next start fails with exit code 77. An application that is already running keeps the values it was started with until it stops.",
      ),
      p(
        "To give the machine access again, issue a new credential. If the revocation's end was not confirmed, the row says revoking: treat the token as still accepted until it says revoked.",
      ),
    ],
    related: ["rotate-token", "states"],
  },
  {
    id: "states",
    title: "What does each state mean?",
    summary: "Every state a badge can show, what it means, and what to do about it.",
    category: "activity",
    keywords: ["state", "status", "badge", "pending", "active", "archived", "revoking", "meaning"],
    blocks: [
      p(
        "A state is a word and a shape; the colour only repeats them. Hover over or focus a badge to see its meaning.",
      ),
      { kind: "generated", what: "states" },
    ],
    related: ["uncertain", "needs-review"],
  },
  {
    id: "uncertain",
    title: 'What does "uncertain" mean, and what do I do?',
    summary:
      "MyKey sent a change but could not confirm whether it took effect. Do not repeat it: an operator settles it.",
    category: "trouble",
    keywords: ["uncertain", "unknown", "outcome", "not known", "operation", "stuck"],
    popular: true,
    blocks: [
      p(
        "An operation is uncertain when the secret store did not answer clearly: the change may or may not have taken effect. The page never repeats it, because repeating could do it twice.",
      ),
      steps(
        "Do not enter the change a second time.",
        "Note the operation's id from Operations.",
        "Tell your operator. They check the change on the host and settle it; open Operations again to see the settled state.",
      ),
      screen("operations", "Go to Operations"),
    ],
    related: ["needs-review", "activity-audit-operations", "states"],
  },
  {
    id: "needs-review",
    title: 'What is "needs review"?',
    summary:
      "The server could not confirm a state in the secret store, so it stops and waits for an operator.",
    category: "trouble",
    keywords: ["needs review", "review", "blocked", "locked", "under review"],
    blocks: [
      p(
        "A project, an environment, a secret or a credential needs review when what the database says and what the secret store holds could not be matched. Nothing on the page can change it until it is settled, so nothing is offered.",
      ),
      p(
        "A project or an environment in review shows the reason the server gave. Your operator settles it from the host, by the reconciliation runbook.",
      ),
    ],
    related: ["uncertain", "states"],
  },
  {
    id: "activity-audit-operations",
    title: "Activity, Audit and Operations: the difference",
    summary:
      "Activity shows the product's events, one line per operation; Audit lists every recorded event with its details; Operations lists the changes of one environment.",
    category: "activity",
    keywords: [
      "activity",
      "audit",
      "operations",
      "log",
      "history",
      "who",
      "revealed",
      "events",
      "timeline",
    ],
    popular: true,
    blocks: [
      list(
        "Activity: what people and machines did in the organization in the last 30 days: each change, reveal, import, export and machine read, with who did it, where, and how it ended.",
        "Audit: every recorded event and its outcome, with filters, for checking. Events are kept for 365 days.",
        "Operations: the changes the service carried out for one environment, and their state.",
      ),
      p(
        "To find who revealed a secret today, open Audit and filter by the action secret.reveal: each reveal is a row with the user's id and, in its details, the secret's name.",
      ),
      screen("activity", "Go to Activity"),
      screen("audit", "Go to Audit"),
    ],
    related: ["uncertain", "states"],
  },
  {
    id: "export-risks",
    title: "How do I export, and what are the risks?",
    summary:
      "An export writes every live value of one environment into a plain-text .env file that MyKey cannot protect.",
    category: "import-export",
    keywords: ["export", "download", "backup", "dotenv", ".env", "file", "risk"],
    blocks: [
      p(
        "On Import and export, press Export, type the environment's name to confirm, and save the file. An export needs a recent code from your authenticator, and is recorded in Activity.",
      ),
      note(
        "The file is outside MyKey from the moment it is saved: MyKey cannot protect it, cannot see who reads it and cannot take it back. Delete it as soon as you no longer need it.",
        "warning",
      ),
      p(
        `An export can be larger than an import accepts (${IMPORT_MIB} MiB), so a large export cannot always be imported again in one file.`,
      ),
      screen("import", "Go to Import and export"),
    ],
    related: ["add-secrets", "known-limits"],
  },
  {
    id: "authenticator",
    title: "Setting up your authenticator",
    summary:
      "An authenticator app shows a new six-digit code every 30 seconds; every sign-in needs one.",
    category: "account",
    keywords: [
      "authenticator",
      "totp",
      "2fa",
      "mfa",
      "two-factor",
      "app",
      "code",
      "setup key",
      "enrol",
      "enroll",
    ],
    blocks: [
      steps(
        "Install an authenticator app on your phone or computer.",
        "Add an account in it by typing the setup key the page shows. There is no QR code.",
        "Type the code the app shows to finish.",
        `Keep the ${CODES} recovery codes the page then shows somewhere safe and offline. They are shown once.`,
      ),
    ],
    related: ["lost-authenticator", "re-verification"],
  },
  {
    id: "lost-authenticator",
    title: "I lost my phone or my authenticator",
    summary: "Sign in with a recovery code, or ask your operator for a reset link.",
    category: "account",
    keywords: [
      "lost phone",
      "lost",
      "phone",
      "authenticator",
      "new phone",
      "reset",
      "locked out",
      "recovery",
    ],
    popular: true,
    blocks: [
      steps(
        "If you have a recovery code: sign in with your password, then use the recovery code instead of a code from the app. Each code works once.",
        "Then, under Account, make new recovery codes if few are left.",
        "If you have no recovery code: ask your operator for a reset link. It works once and expires after 15 minutes. With it you set a new password and a new authenticator.",
      ),
      note(
        "When the operator issues a reset link, every session of the account ends. After a reset of the authenticator, the old authenticator and every old recovery code stop working.",
      ),
    ],
    related: ["lost-recovery-codes", "authenticator"],
  },
  {
    id: "lost-recovery-codes",
    title: "I lost my recovery codes",
    summary:
      "While you can still sign in, make new ones under Account; they replace every old one.",
    category: "account",
    keywords: ["recovery codes", "lost", "backup codes", "new codes", "regenerate"],
    blocks: [
      p(
        `Under Account, Recovery codes, press Make new recovery codes. You get ${CODES} new codes, shown once; every code you had before stops working, used or not. This needs a recent code from your authenticator.`,
      ),
      p(
        "If you have lost both the authenticator and the codes, ask your operator for a reset link.",
      ),
      screen("account", "Go to Account"),
    ],
    related: ["lost-authenticator"],
  },
  {
    id: "re-verification",
    title: "Why am I asked for a code again?",
    summary: `Some actions need a code from your authenticator from the last ${FRESH_MINUTES} minutes, even when you are signed in.`,
    category: "account",
    keywords: ["code again", "step-up", "re-verification", "verify", "fresh", "asked again"],
    blocks: [
      p(
        `Exporting an environment, issuing a machine credential, making new recovery codes and changing the password each need a code entered within the last ${FRESH_MINUTES} minutes. A session signed in with a recovery code has none. The page asks for one and then lets you do it again.`,
      ),
    ],
    related: ["authenticator", "export-risks"],
  },
  {
    id: "sign-out-sessions",
    title: "How do I sign out other sessions?",
    summary: "Under Account, Sessions, end one session or every session at once.",
    category: "account",
    keywords: ["sign out", "log out", "sessions", "other devices", "end session"],
    blocks: [
      p(
        "Account lists every place this account is signed in. End session ends one. End every session ends all of them, this one included; you then sign in again.",
      ),
      p("Changing your password also ends your other sessions."),
      screen("account", "Go to Account"),
    ],
    related: ["account"],
  },
  {
    id: "account",
    title: "Your account: password, recovery codes and sessions",
    summary: "What each part of Account protects, and when to use it.",
    category: "account",
    keywords: ["account", "password", "change password", "profile", "security"],
    blocks: [
      list(
        "Password: change it with the current one and a recent code from your authenticator. Your other sessions end; this one stays signed in.",
        "Recovery codes: replace them when you have used some or think they were seen.",
        "Sessions: end the ones you do not recognise.",
      ),
      screen("account", "Go to Account"),
    ],
    related: ["sign-out-sessions", "lost-recovery-codes"],
  },
  {
    id: "sign-in-help",
    title: "Signing in",
    summary: "Your e-mail and password, then a code from your authenticator app.",
    category: "account",
    keywords: ["sign in", "login", "log in", "password", "forgot password", "locked"],
    blocks: [
      list(
        "There is no sign-up and no self-service reset: accounts and reset links come from your operator.",
        "After five failed sign-ins, the account refuses new attempts for 15 minutes.",
        "A session ends after 30 minutes without use, and after 12 hours in any case.",
      ),
    ],
    related: ["lost-authenticator", "authenticator"],
  },
  {
    id: "service-gate",
    title: 'What is the service gate, and what does "the service is not open" mean?',
    summary:
      "The operator opens and closes the service with its gate; while it is closed, requests are refused.",
    category: "trouble",
    keywords: ["service gate", "not open", "closed", "gate", "maintenance", "503", "quarantined"],
    blocks: [
      p(
        "The operator closes the gate for maintenance, a deploy or a restore, and opens it when the service is checked. While it is closed, the workspace and every machine are refused, and nothing is changed.",
      ),
      p(
        '"The service is not open" is that refusal. Wait, then press Reload. If it lasts, ask your operator.',
      ),
    ],
    related: ["sealed", "restores"],
  },
  {
    id: "sealed",
    title: 'What is "sealed"?',
    summary: "The secret store is locked and can read nothing until it is unsealed on the host.",
    category: "trouble",
    keywords: ["sealed", "unseal", "locked", "secret store", "openbao", "kms"],
    blocks: [
      p(
        "The secret store unlocks itself at start with a key held by a key management service. If it cannot reach that service, it stays sealed: no secret can be read or written, and the page says so.",
      ),
      p("Nothing on the page can unseal it. Your operator follows the unseal runbook on the host."),
    ],
    related: ["service-gate"],
  },
  {
    id: "restores",
    title: "Restores, from the owner's side",
    summary:
      "After a restore, sign in again, issue new machine tokens, and check your latest changes.",
    category: "trouble",
    keywords: ["restore", "backup", "disaster", "recovered", "after a restore", "lost data"],
    blocks: [
      p(
        "A restore brings the service back to its last eligible backup, taken nightly. Every account is reset and every token is revoked: you sign in with the reset link your operator gives you, and each machine needs a new token.",
      ),
      p(
        "Changes made after that backup are not in the restored service. Check your latest secrets, and enter again what is missing.",
      ),
    ],
    related: ["rotate-token", "service-gate"],
  },
  {
    id: "known-limits",
    title: "What MyKey does not do",
    summary: "The known limits of this stage of the service, where each was measured or decided.",
    category: "limits",
    keywords: ["limits", "does not", "cannot", "known limits", "not supported", "missing"],
    popular: true,
    blocks: [
      p("The same list is known-limits.md in the repository."),
      { kind: "generated", what: "known-limits" },
    ],
    related: ["export-risks"],
  },
  {
    id: "errors",
    title: "Error messages, A to Z",
    summary:
      "Every message the workspace can show when something is refused or fails, and the safe next step.",
    category: "trouble",
    keywords: ["error", "message", "refused", "failed", "denied", "not found", "code"],
    blocks: [
      p(
        "Each message names what happened and the safe next step. A request id, when there is one, is what your operator needs to find the request.",
      ),
      { kind: "generated", what: "errors" },
    ],
    related: ["uncertain", "service-gate"],
  },
  {
    id: "cli-exit-codes",
    title: "The CLI's exit codes",
    summary:
      "What each exit code of secrets means: 77 the token is not accepted, 69 the service cannot give the set.",
    category: "credentials",
    keywords: [
      "exit code",
      "exit",
      "77",
      "69",
      "64",
      "cli",
      "secrets run",
      "denied",
      "unavailable",
    ],
    blocks: [
      p(
        "The CLI writes one line on standard error, with a category, a code and a request id, and never a value or a token.",
      ),
      { kind: "generated", what: "cli-exit-codes" },
    ],
    related: ["connect-app", "revoke-credential"],
  },
  {
    id: "glossary",
    title: "Glossary",
    summary: "The words of the workspace, as the API, the CLI and the runbooks use them.",
    category: "reference",
    keywords: ["glossary", "words", "terms", "definition", "meaning"],
    blocks: [{ kind: "generated", what: "glossary" }],
    related: ["states"],
  },
  {
    id: "api-reference",
    title: "The API reference",
    summary: "Every route of the API, its request and its answers, served by the service itself.",
    category: "reference",
    keywords: ["api", "reference", "openapi", "routes", "http"],
    blocks: [
      p("The reference lists every route of the service with its request and its answers."),
      { kind: "external", href: "/v1/reference", text: "Open the API reference" },
    ],
    related: ["cli-exit-codes"],
  },
];

export function articleOf(id: string): Article | undefined {
  return ARTICLES.find((article) => article.id === id);
}

/** The runbooks for the operator, by name: they are files of the repository, not pages here. */
export const OPERATOR_RUNBOOKS: readonly { file: string; what: string }[] = [
  {
    file: "start-here.md",
    what: "The owner's first run, from the reset link to a running application.",
  },
  { file: "operator-accounts.md", what: "Accounts: the first owner, reset links." },
  { file: "provisioning.md", what: "Creating and checking an organization." },
  { file: "reconciliation.md", what: "Settling uncertain operations and items that need review." },
  { file: "service-gate.md", what: "Opening and closing the service." },
  { file: "kms-and-unseal.md", what: "Unsealing the secret store and replacing its certificates." },
  { file: "backup.md", what: "The nightly backups and their checks." },
  { file: "restore.md", what: "Restoring the service from a backup." },
  { file: "consumer-local.md", what: "An application on a developer's machine." },
  { file: "consumer-deploy.md", what: "An application on a server." },
  {
    file: "machine-credentials.md",
    what: "Issuing, listing and revoking tokens, and what their states mean.",
  },
  { file: "known-limits.md", what: "What the service does not do." },
];
