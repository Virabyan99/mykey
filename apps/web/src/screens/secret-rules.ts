// The contract's rules for a secret's name and value (FR-1.20), said in the
// page's words and checked with the contract's own functions before a
// request leaves. The server checks again; a message never repeats the value.
import { LIMITS, SECRET_NAME_PATTERN, checkSecretName, checkSecretValue } from "@mykey/contracts";

const bytes = LIMITS.secret.valueMaxBytes.toLocaleString("en-US");

export const SECRET_NAME_RULE = `A secret name is 1 to ${String(LIMITS.secret.nameMaxLength)} characters: upper-case letters, digits and underscores, starting with a letter. It may not start with ${LIMITS.secret.reservedPrefix}, and it cannot be changed later.`;
export const SECRET_VALUE_RULE = `A value is at most ${bytes} bytes of UTF-8 text and has no NUL character. It may be empty and may have several lines.`;
export const PREFIX_RULE =
  "A name starts with an upper-case letter and has only upper-case letters, digits and underscores.";

export const secretNameProblem = (name: string): string | null =>
  checkSecretName(name).ok ? null : SECRET_NAME_RULE;
export const secretValueProblem = (value: string): string | null =>
  checkSecretValue(value).ok ? null : SECRET_VALUE_RULE;
export const prefixProblem = (prefix: string): string | null =>
  SECRET_NAME_PATTERN.test(prefix) ? null : PREFIX_RULE;

/** The version an operation's result names, when it names one. */
export function versionOf(result: Readonly<Record<string, unknown>> | undefined): number | null {
  const version = result?.version;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}
