import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOUND_EXIT_CODE,
  dependencyScanArgs,
  dependencyScanCoverageProblem,
  imageScanArgs,
  secretHistoryScanArgs,
  secretScanCoverageProblem,
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

describe("secret scan coverage", () => {
  it("a history scan that read no commit is a failure, not a pass", () => {
    const nothing = [
      "fatal: not a git repository (or any of the parent directories): .git",
      "INF 0 commits scanned.",
      "INF no leaks found",
    ].join("\n");
    // The git error is reported first; without it the zero count is.
    expect(secretScanCoverageProblem(nothing, false)).toMatch(/error/);
    expect(secretScanCoverageProblem("INF 0 commits scanned.", false)).toMatch(/no commit/);
    expect(secretScanCoverageProblem("INF no leaks found", false)).toMatch(/no commit/);
  });

  it("a scan that printed a git or gitleaks error is a failure even with commits", () => {
    const broken =
      "ERR git error encountered, see logs\nINF 19 commits scanned.\nINF no leaks found";
    expect(secretScanCoverageProblem(broken, false)).toMatch(/error/);
    const fatal = "fatal: bad object HEAD\nINF 3 commits scanned.";
    expect(secretScanCoverageProblem(fatal, false)).toMatch(/error/);
  });

  it("a shallow checkout is a failure: the scan must see the whole history", () => {
    expect(secretScanCoverageProblem("INF 1 commits scanned.\nINF no leaks found", true)).toMatch(
      /shallow/,
    );
  });

  it("accepts a full-history scan that read commits", () => {
    const fine = "INF 19 commits scanned.\nINF scanned ~1.2 MB in 2s\nINF no leaks found";
    expect(secretScanCoverageProblem(fine, false)).toBeUndefined();
  });

  it("the CI job checks out the whole history", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const job = /\n {2}secret-scan:\n([\s\S]*?)\n {2}[a-z-]+:\n/.exec(workflow)?.[1] ?? "";
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain("node scripts/ci-scan.ts secrets");
  });
});

describe("dependency scan coverage of the lockfile row", () => {
  it("a pnpm-lock.yaml row without a count means it was not scanned", () => {
    const notScanned = "│ pnpm-lock.yaml │ pnpm │        -        │";
    expect(dependencyScanCoverageProblem(notScanned)).toBe(
      "dependency scan did not cover pnpm-lock.yaml",
    );
    expect(dependencyScanCoverageProblem("Scanning pnpm-lock.yaml ... skipped")).toBe(
      "dependency scan did not cover pnpm-lock.yaml",
    );
    expect(dependencyScanCoverageProblem("│ pnpm-lock.yaml │ pnpm │ 12 │")).toBeUndefined();
  });
});

describe("gitleaks configuration", () => {
  /** The lines that carry meaning: no comments, no blank lines, no title. */
  const meaningful = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("title ="));
  const production = meaningful(readFileSync(resolve(root, ".gitleaks.toml"), "utf8"));
  const selftest = meaningful(
    readFileSync(resolve(root, "tests/fixtures/ci/gitleaks-selftest.toml"), "utf8"),
  );

  it("allows exactly one path, the seeded fixture, and nothing else", () => {
    const start = production.indexOf("[[allowlists]]");
    expect(start).toBeGreaterThan(0);
    expect(production.slice(start)).toEqual([
      "[[allowlists]]",
      'description = "seeded canary used by the scanner self-test"',
      "paths = ['''^tests/fixtures/ci/seeded-secret/''']",
    ]);
    expect(production.filter((line) => /allowlist/i.test(line))).toEqual(["[[allowlists]]"]);
  });

  it("is what the self-test runs, minus that allowlist", () => {
    expect(selftest).toEqual(production.slice(0, production.indexOf("[[allowlists]]")));
    expect(selftest.join("\n")).not.toMatch(/allowlist/i);
  });
});

describe("secret scan coverage with coloured output", () => {
  const esc = String.fromCharCode(27);
  it("reads the level and the count through gitleaks' colour codes", () => {
    const fine = `${esc}[90m3:48PM${esc}[0m ${esc}[32mINF${esc}[0m ${esc}[1m19 commits scanned.${esc}[0m`;
    expect(secretScanCoverageProblem(fine, false)).toBeUndefined();
    const broken = `${esc}[31mERR${esc}[0m ${esc}[1mgit error${esc}[0m\n${fine}`;
    expect(secretScanCoverageProblem(broken, false)).toMatch(/error/);
    const zero = `${esc}[32mINF${esc}[0m ${esc}[1m0 commits scanned.${esc}[0m`;
    expect(secretScanCoverageProblem(zero, false)).toMatch(/no commit/);
  });
});
