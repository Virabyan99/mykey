// Secret output of an operator command (Review focus 3): a reset link, a
// recovery code, a delivered credential is never printed. It is written to a
// file readable by the operator only, under ~/.mykey/out/ (outside the
// repository and OneDrive), and only the path is printed.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,40}$/;

function timestamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.[0-9]{3}Z$/, "Z");
}

/** The directory secret output goes to: `<home>/.mykey/out`, mode 0700. */
export function outDirectory(home: string = homedir()): string {
  const directory = join(home, ".mykey", "out");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

/** Writes `content` to a new 0600 file `<utc-timestamp>-<name>` and returns its path. Never overwrites. */
export function writeSecretFile(
  name: string,
  content: string,
  opts: { home?: string; at?: Date } = {},
): string {
  if (!NAME.test(name)) throw new Error("writeSecretFile: the name must be a plain word");
  const directory = outDirectory(opts.home);
  const base = `${timestamp(opts.at ?? new Date())}-${name}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const path = join(directory, attempt === 1 ? base : `${base}-${String(attempt)}`);
    try {
      writeFileSync(path, content, { mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("writeSecretFile: no free file name");
}
