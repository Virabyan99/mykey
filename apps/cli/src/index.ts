/** The CLI binary name and token variable fixed by decision D-08. */
export const CLI_NAME = "secrets";
export const MACHINE_TOKEN_VARIABLE = "SECRETS_MACHINE_TOKEN";

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
