import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOUND_EXIT_CODE,
  dependencyScanArgs,
  dependencyScanCoverageProblem,
  imageScanArgs,
  secretHistoryScanArgs,
  selftestSecretArgs,
  selftestVerdict,
  selftestVulnerabilityArgs,
} from "../../../scripts/ci-scan.ts";
import { loadLock } from "../../../scripts/pins-verify.ts";

const root = resolve(import.meta.dirname, "../../..");
const lock = loadLock(root);

describe("scanner commands", () => {
  it("run the gitleaks image by the digest in the lock, over the whole history", () => {
    const args = secretHistoryScanArgs(lock, "/work/repo");
    expect(args).toContain(`${lock.images.gitleaks!.image}@${lock.images.gitleaks!.digest}`);
    expect(args).toContain("git");
    expect(args).toContain("/repo/.gitleaks.toml");
    expect(args.join(" ")).toContain(`--exit-code ${FOUND_EXIT_CODE}`);
    expect(args.join(" ")).not.toContain("--no-git");
    expect(args.join(" ")).not.toContain("--log-opts");
  });

  it("run Trivy by digest with the fixed severity flags and without the CI fixtures", () => {
    const args = dependencyScanArgs(lock, "/work/repo").join(" ");
    expect(args).toContain(`${lock.images.trivy!.image}@${lock.images.trivy!.digest}`);
    expect(args).toContain("fs --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed");
    expect(args).toContain(`--exit-code ${FOUND_EXIT_CODE}`);
    expect(args).toContain("--skip-dirs tests/fixtures/ci");
    expect(args).toContain("--ignorefile /repo/.trivyignore");
  });

  it("scan each runtime image by its pinned digest", () => {
    const args = imageScanArgs(lock, "postgres").join(" ");
    expect(args).toContain("image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed");
    expect(args).toContain(`${lock.images.postgres!.image}@${lock.images.postgres!.digest}`);
    expect(() => imageScanArgs(lock, "no-such-image")).toThrow(/not in the lock/);
  });

  it("self-test commands point at the seeded fixtures and do not skip them", () => {
    const secret = selftestSecretArgs(lock, "/work/repo").join(" ");
    expect(secret).toContain("dir /repo/tests/fixtures/ci/seeded-secret");
    expect(secret).toContain("/repo/tests/fixtures/ci/gitleaks-selftest.toml");
    expect(secret).toContain("--redact");
    const vulnerability = selftestVulnerabilityArgs(lock, "/work/repo").join(" ");
    expect(vulnerability).toContain("/repo/tests/fixtures/ci/vulnerable-dep");
    expect(vulnerability).not.toContain("--skip-dirs tests/fixtures/ci");
  });
});

describe("scan coverage", () => {
  it("includes development dependencies, which is where this repository keeps its toolchain", () => {
    expect(dependencyScanArgs(lock, "/work/repo")).toContain("--include-dev-deps");
  });

  it("honours reviewed false positives through .gitleaksignore only", () => {
    const args = secretHistoryScanArgs(lock, "/work/repo").join(" ");
    expect(args).toContain("--gitleaks-ignore-path /repo");
  });

  it("a dependency scan that did not read pnpm-lock.yaml is a failure, not a pass", () => {
    const empty = "WARN Supported files for scanner(s) not found. │   -    │  -   │    -    │";
    expect(dependencyScanCoverageProblem(empty)).toBe(
      "dependency scan did not cover pnpm-lock.yaml",
    );
    const covered = "│ pnpm-lock.yaml │ pnpm │        0        │";
    expect(dependencyScanCoverageProblem(covered)).toBeUndefined();
  });
});

describe("scanner self-test verdict", () => {
  it("passes only when the scanner reports a finding and names the seeded item", () => {
    const verdict = selftestVerdict(
      "secret",
      FOUND_EXIT_CODE,
      "RuleID: mykey-canary",
      "mykey-canary",
    );
    expect(verdict.ok).toBe(true);
  });

  it("fails when the scanner exits zero", () => {
    const verdict = selftestVerdict("secret", 0, "no leaks found", "mykey-canary");
    expect(verdict).toEqual({ ok: false, message: "scanner did not detect the seeded secret" });
  });

  it("fails when the scanner crashed instead of reporting a finding", () => {
    const verdict = selftestVerdict("vulnerability", 1, "FATAL: could not download DB", "lodash");
    expect(verdict).toEqual({
      ok: false,
      message: "scanner did not detect the seeded vulnerability",
    });
    expect(selftestVerdict("vulnerability", null, "", "lodash").ok).toBe(false);
  });

  it("fails when a finding is reported but not the seeded one", () => {
    const verdict = selftestVerdict("vulnerability", FOUND_EXIT_CODE, "other-package", "lodash");
    expect(verdict.ok).toBe(false);
  });
});
