import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const cloudTests = "tests/**/*.cloud.test.ts";

// Session 6 gate: pnpm 10 passes the `--` of `pnpm run test:staging -- <file>`
// through, and vitest then drops the file filter and runs every file of the
// project (on staging: the drills and the reboots). Refuse it.
if (process.argv.slice(2).includes("--")) {
  throw new Error(
    "vitest: drop the `--` (pnpm run test:staging <file>): with it vitest runs every file of the project",
  );
}

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
        // Run 5.8: the consumer fixtures and the rehearsed consumer runbooks
        // (staging over its public name); run through `pnpm run test:consumers`.
        test: {
          name: "consumers",
          include: ["tests/consumers/**/*.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 1_800_000,
          fileParallelism: false,
        },
      },
      {
        // Run 5.9: the reference in Chromium (Playwright) against a local test API;
        // `pnpm exec playwright install chromium` first.
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          globalSetup: ["tests/harness/global-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 300_000,
          fileParallelism: false,
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
