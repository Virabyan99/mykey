// The workspace's modules that need no browser: the unit tests read them
// here. The application itself starts in main.tsx and is built by build.ts.
export { explain, type Explanation, type Failure } from "./errors/explain.ts";
export {
  STATE_LABELS,
  stateLabel,
  type Shape,
  type StateKind,
  type StateLabel,
  type Tone,
} from "./labels.ts";
export { POLL_DELAYS_MS, isTerminal, nextPollDelay } from "./api/poll.ts";
export { SECRET_BEARING, type SecretBearing } from "./api/secret-routes.ts";
export {
  EMPTY_HOLD,
  EPHEMERAL_TTL_MS,
  hold,
  type Held,
  type HoldEvent,
  type HoldRules,
} from "./state/ephemeral.ts";
// Run 9.0 (P-159): the catalogue of every text the page shows, and its lint.
export { PAGES, pageCopy, type PageCopy, type PageId } from "./copy/pages.ts";
export { STATES, stateCopy, type StateCopy } from "./copy/states.ts";
export { ACTIONS } from "./copy/actions.ts";
export { GLOSSARY, type GlossaryEntry, type GlossaryId } from "./copy/glossary.ts";
export { ALLOWED_DENIALS, BANNED_CLAIMS, lintText, stringsOf } from "./copy/lint.ts";
export {
  ARTICLES,
  CATEGORIES,
  CLI_EXIT_CODES,
  OPERATOR_RUNBOOKS,
  articleOf,
  type Article,
  type Block,
} from "./help/articles.ts";
export { searchHelp, stem, words, type HelpHit } from "./help/search.ts";
export { localSteps, runbookSections, serverSteps, type ConnectStep } from "./connect/commands.ts";
export { matchEntries, paletteEntries, type PaletteEntry } from "./palette/sources.ts";
export { CONNECT_STEPS } from "./copy/connect.ts";
export { CREDENTIAL_COPY } from "./copy/credentials.ts";
export { TOKEN_WARNING } from "./connect/commands.ts";
export { CONSUMER_DEPLOY, CONSUMER_LOCAL } from "./connect/runbooks.ts";
