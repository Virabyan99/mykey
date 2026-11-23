// The agent proof's file sweep (review finding 5): the files are searched
// inside the container, with the needles on stdin, so there is no copy that
// can stop half-way; the script fails as a whole when a step fails.

/** Paths under the home directory that are not searched, as `find -path` patterns. */
export const SWEEP_EXCLUDED = [
  "./.config/mykey/machine-token",
  "*/node_modules",
  "*/.next",
  "./.npm",
  "./.local/share/mykey",
] as const;

/** The script for `sh -c`, run as root in the container; it prints files=, needles= and control=. */
export function sweepScript(control: string, home = "/home/node"): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(control)) throw new Error("the control is a name");
  const prune = SWEEP_EXCLUDED.map((p) => `-path '${p}'`).join(" -o ");
  return [
    "set -e",
    "cat > /tmp/sweep-needles",
    `cd ${home}`,
    `find . \\( ${prune} \\) -prune -o -type f -size -32M -print > /tmp/sweep-files`,
    "printf 'files=%s\\n' \"$(wc -l < /tmp/sweep-files)\"",
    "printf 'needles=%s\\n' \"$(xargs -r -d '\\n' grep -Foh -f /tmp/sweep-needles < /tmp/sweep-files | wc -l)\"",
    `printf 'control=%s\\n' "$(xargs -r -d '\\n' grep -lF ${control} < /tmp/sweep-files | wc -l)"`,
    "rm -f /tmp/sweep-needles /tmp/sweep-files",
  ].join("; ");
}

/** The needles as grep -F patterns: one line each, long enough to mean something. */
export function sweepPatterns(needles: readonly string[]): string {
  const lines = needles
    .flatMap((n) => n.split("\n"))
    .filter((line) => line.length >= 8 && !line.startsWith("-----"));
  return `${lines.join("\n")}\n`;
}

/** The three counts from the script's output; NaN for a missing one. */
export function sweepCounts(out: string): { files: number; needles: number; control: number } {
  const field = (name: string): number =>
    Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(out)?.[1] ?? Number.NaN);
  return { files: field("files"), needles: field("needles"), control: field("control") };
}
