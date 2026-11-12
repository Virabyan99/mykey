// Redaction of secrets on the operator's workstation (Run 2.5, Review focus 2).
// Moved from tests/harness/staging.ts in Run 3.2 (M17).

// ------------------------------------------------------------------- secrets

const secrets = new Set<string>();

/** From now on, every redacted text has `value` replaced by "[redacted]". */
export function registerSecret(value: string): void {
  if (value.trim() === "") return;
  secrets.add(value);
  secrets.add(value.trim());
}

export function redact(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

export function registerOutput(text: string): void {
  registerSecret(text);
  for (const line of text.split("\n")) {
    // Short lines ("}", "ok") would make every log unreadable; generated secrets are long.
    if (line.trim().length >= 8) registerSecret(line);
  }
}

/** True when a command or script names a secret directory (Review focus 2). A guard, not a sandbox. */
export function mentionsSecretPath(text: string): boolean {
  const normal = text.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");
  return (
    normal.includes("mykey/secrets") ||
    normal.includes("mykey-custody") ||
    (normal.includes("/etc/mykey") && /\bsecrets\b/.test(normal))
  );
}
