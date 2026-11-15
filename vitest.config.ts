import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const cloudTests = "tests/**/*.cloud.test.ts";

/**
 * Dated checkpoints (Run 2.7): a checkpoint's test file stays out of the
 * staging run until its `notBefore`, unless MYKEY_CHECKPOINT names it (then
 * the file itself says "checkpoint not due" when it is early).
 */
function checkpointFilesNotDue(): string[] {
  const file = "docs/evidence/session-2/kms-checkpoints.json";
  // Not prepared yet (key-loss.staging.test.ts writes it): nothing to check.
  if (!existsSync(file)) return ["tests/staging/kms-expiry.staging.test.ts"];
  const entries = JSON.parse(readFileSync(file, "utf8")) as {
    id: string;
    notBefore: string;
    file: string;
  }[];
  return entries
    .filter((entry) => entry.id !== process.env.MYKEY_CHECKPOINT)
    .filter((entry) => Date.now() < Date.parse(entry.notBefore))
    .map((entry) => entry.file);
}

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: [cloudTests],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts", "tests/fault/**/*.test.ts"],
          exclude: [cloudTests],
          globalSetup: ["tests/harness/global-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
      {
        test: {
          name: "cli",
          include: ["tests/cli/**/*.test.ts"],
          // POSIX only (P-97): on Windows, `pnpm run test:cli` runs it in Linux.
          globalSetup: ["tests/cli/setup.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "cloud",
          include: [cloudTests],
        },
      },
      {
        // The staging host over the VPN; run through `pnpm run test:staging`.
        test: {
          name: "staging",
          include: ["tests/staging/**/*.staging.test.ts"],
          exclude: checkpointFilesNotDue(),
          testTimeout: 300_000,
          hookTimeout: 900_000,
          // One host: suites must not reboot it under each other.
          fileParallelism: false,
        },
      },
    ],
  },
});
