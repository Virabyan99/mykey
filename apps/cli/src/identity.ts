/** The CLI binary name and token variable fixed by decision D-08. */
export const CLI_NAME = "secrets";
export const MACHINE_TOKEN_VARIABLE = "SECRETS_MACHINE_TOKEN";

declare const __MYKEY_CLI_VERSION__: string | undefined;

/** Compiled in by apps/cli/build.ts from package.json; "dev" when run from source. */
export const CLI_VERSION: string =
  typeof __MYKEY_CLI_VERSION__ === "string" ? __MYKEY_CLI_VERSION__ : "dev";

/** Stage 1 targets (Doc 10 §4.2). Native Windows is out of scope. */
export const SUPPORTED_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;

export function currentTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

export function isSupportedTarget(target: string): boolean {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}
