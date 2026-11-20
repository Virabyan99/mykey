// Where the CLI finds its API, and which environment it asks for (P-96,
// FR-1.79). The URL comes from SECRETS_API_URL, else from
// ${XDG_CONFIG_HOME:-$HOME/.config}/mykey/config.json, which holds
// {"apiUrl": "https://…"} and nothing else (a configuration file never holds a
// credential). The file must belong to the user and be writable by nobody
// else. Only a plain https origin is accepted.
import { ENVIRONMENT_NAME_PATTERN } from "@mykey/contracts";
import type { Parsed } from "./args.ts";
import type { Selector } from "./client.ts";
import { CliError } from "./errors.ts";

export const CONFIG_PATH_TEXT = "${XDG_CONFIG_HOME:-$HOME/.config}/mykey/config.json";

type Read = (path: string) => { text: string; mode: number; uid: number } | null;

const unsupported = (text: string): CliError => new CliError("unsupported", text);

function checkUrl(raw: string, from: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsupported(`${from} is not a URL`);
  }
  if (url.protocol !== "https:") throw unsupported(`${from} must be an https URL`);
  if (url.username !== "" || url.password !== "") {
    throw unsupported(`${from} must not carry a user name or password`);
  }
  // A bare "?" or "#" leaves search and hash empty, so the text is checked too.
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw unsupported(`${from} must not carry a query or a fragment`);
  }
  if (url.pathname !== "/") throw unsupported(`${from} must be the API's origin, without a path`);
  return url;
}

/**
 * R5-2 (Run 8.6, D-68): a certificate authority this CLI alone trusts, beside
 * the public roots, from the PEM file SECRETS_CA_FILE names. Node's own
 * variables for that are refused (guard.ts): a machine-wide setting is never
 * meant for this CLI. Children never see it (no SECRETS_* reaches them).
 */
export function extraCaOf(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string,
): string | undefined {
  const path = env.SECRETS_CA_FILE;
  if (path === undefined || path === "") return undefined;
  let text: string;
  try {
    text = read(path);
  } catch {
    throw unsupported("SECRETS_CA_FILE cannot be read");
  }
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    throw unsupported("SECRETS_CA_FILE holds no certificate");
  }
  return text;
}

export function resolveApiUrl(env: NodeJS.ProcessEnv, read: Read, uid: number): URL {
  const fromEnv = env.SECRETS_API_URL;
  if (fromEnv !== undefined && fromEnv !== "") return checkUrl(fromEnv, "SECRETS_API_URL");

  const base =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : env.HOME !== undefined && env.HOME !== ""
        ? `${env.HOME}/.config`
        : null;
  const file = base === null ? null : read(`${base}/mykey/config.json`);
  if (file === null) {
    throw unsupported(`no API URL: set SECRETS_API_URL or write ${CONFIG_PATH_TEXT}`);
  }
  if (file.uid !== uid) throw unsupported("the configuration file belongs to another user");
  if ((file.mode & 0o022) !== 0) {
    throw unsupported("the configuration file is writable by group or others");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw unsupported("the configuration file is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof (parsed as { apiUrl?: unknown }).apiUrl !== "string"
  ) {
    throw unsupported('the configuration file must hold exactly {"apiUrl": "https://…"}');
  }
  return checkUrl((parsed as { apiUrl: string }).apiUrl, "the configuration file's apiUrl");
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The environment asked for: a flag wins over SECRETS_PROJECT / SECRETS_ENVIRONMENT. */
export function selectorOf(parsed: Parsed, env: NodeJS.ProcessEnv): Selector {
  const project = parsed.project ?? env.SECRETS_PROJECT ?? "";
  const environment = parsed.env ?? env.SECRETS_ENVIRONMENT ?? "";
  if (project === "") throw new CliError("usage", "no project: give --project or SECRETS_PROJECT");
  if (environment === "") {
    throw new CliError("usage", "no environment: give --env or SECRETS_ENVIRONMENT");
  }
  if (!PROJECT_ID.test(project)) throw new CliError("usage", "the project must be a project id");
  if (!ENVIRONMENT_NAME_PATTERN.test(environment)) {
    throw new CliError("usage", "the environment must be an environment name");
  }
  return { project, env: environment };
}
