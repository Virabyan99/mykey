# Run 5.7 — CLI distribution and the four platforms

**Result: DONE WITH AN OPEN ITEM on 15 Nov 2026.** The release `cli-v0.1.0` exists, and its installer and full suite pass on Linux x64 and arm64 from the downloaded files. The macOS runners failed on the suite's test certificates; the fix has not yet run on macOS (`cli-matrix.md`).

- **Task A, the first choice:** Node's single-executable applications. Read `https://nodejs.org/docs/v24.22.2/api/single-executable-applications.html` on 15 Nov 2026. It says, word for word:
  - stability: "Stability: 1.1 - Active development";
  - platforms: macOS "arm64 only; x64 is not currently supported";
  - injection needs "any tool which can inject resources into the binary".

  So the first choice fails, and the fallback is taken: the bundle on the pinned Node (D-44).

- **Task B, the release and the installer:**
  - `infra/release/cli/build-release.ts` builds a deterministic archive, `install.sh` from the template, and `SHA256SUMS`.
  - The four Node archives are pinned, and `pins:verify` checks the installer's rendering against them.
  - Tests: `tests/unit/release/build.test.ts` (4), `tests/cli/install.test.ts` (4), `tests/cli/platform.test.ts` (2).
- **Task C, the four runners:**
  - The workflow gained the dispatch inputs `jobs` and `cli_release`. `cli-matrix` downloads the release, checks `SHA256SUMS`, runs `install.sh`, then runs project `cli` against the installed launcher and uploads the JSON report. `actions/upload-artifact` v7.0.2 is pinned for that report.
  - Released as `cli-v0.1.0` at `ab814eb`.
  - Task B ran again against the downloaded release in the Linux container: 7 files, 49 tests passed.
  - Matrix run 43734935509, run once:
    - linux-x64 49/49 and linux-arm64 49/49;
    - darwin-x64 and darwin-arm64 16/49 each. All 33 failures there are the suite's test certificates under LibreSSL; installer and platform tests passed on both.
  - The fix to `tests/cli/certs.ts`:
    - its own config;
    - `-sha256`;
    - `openssl ca` with explicit dates for the expired certificate.
  - The fix is guarded by `tests/cli/certs.test.ts`. It was RED and then GREEN under LibreSSL 4.3.1 in a container. Afterwards the suite against the downloaded release passed 8 files and 52 tests on Linux.
  - No second matrix run: the owner has not answered the minutes question (P-99).

FR-1.51 OPEN — Linux x64 and arm64 proven from the release; macOS not proven: run 43734935509 failed on the test certificates and the fix has not run on macOS (the owner's minutes answer is pending).
AC-1.37 OPEN — the connection refusals pass from the release on Linux x64 and arm64; on macOS every TLS case failed on the suite's LibreSSL certificates, fixed but not re-run there.
PO-8 OPEN — installer and launcher proven on all four targets, the full suite only on Linux; credential setup and replacement is Run 5.8.
AGENT-B1 OPEN — D-24's nine requirements pass on Linux x64 and arm64; on macOS only requirements 8 and 9 (`cli-matrix.md`).

## Commands and results

| Command                                                                               | Result                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm run cli:release -- --version 0.1.0`                                             | `SHA256SUMS` 2412bb17… tgz, d07a6f03… install.sh |
| `gh release create cli-v0.1.0 --target session-5 …`                                   | release created at `ab814eb`                     |
| `gh release download cli-v0.1.0` into a fresh directory, `sha256sum -c SHA256SUMS`    | both OK                                          |
| `node scripts/test-cli.ts --release <download>`                                       | 7 files, 49 passed (before the certificate fix)  |
| `gh workflow run ci --ref session-5 -f jobs=cli-matrix -f cli_release=cli-v0.1.0`     | run 43734935509: Linux ×2 pass, macOS ×2 fail    |
| LibreSSL reproduction of `certs.test.ts` (pinned Node Alpine image, `libressl` 4.3.1) | before: `openssl x509 failed`; after: three PASS |
| `node scripts/test-cli.ts --release <download>`                                       | 8 files, 52 passed (after the fix)               |
| `pnpm run check`                                                                      | exit 0                                           |

## Rulings

- The release's `LICENSE` says UNLICENSED. The repository has no licence, and choosing one is the owner's call.
- The Node sums come from `SHASUMS256.txt` over HTTPS; its GPG signature was not checked.
- `actions/upload-artifact` v7.0.2 (`cf430e03…`) is pinned for the JSON report. The plan says the report is "uploaded", and no upload action was pinned before.
- The macOS failure was in the test harness, not in the release. The fix is therefore test-only and the release stays `cli-v0.1.0`; the plan's `cli-v0.1.1` applies only to a fix in the CLI.
- The LibreSSL proof was a container reproduction of `certs.test.ts` without Vitest: Vitest's native binaries need glibc, and the image with LibreSSL is musl. The suite's own run of `certs.test.ts` is on OpenSSL, on Linux.
- No second matrix run, because the owner's answer about minutes is pending (P-99 default).
