import { defineConfig } from "vitest/config";

const cloudTests = "tests/**/*.cloud.test.ts";

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
          testTimeout: 300_000,
          hookTimeout: 900_000,
          // One host: suites must not reboot it under each other.
          fileParallelism: false,
        },
      },
    ],
  },
});
