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
        },
      },
      {
        test: {
          name: "cloud",
          include: [cloudTests],
        },
      },
    ],
  },
});
