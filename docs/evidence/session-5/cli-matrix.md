# CLI matrix — Run 5.7 Task C

**Result: all four targets proven (16 Nov 2026).** The first run (Run 5.7, `cli-v0.1.0`) proved Linux x64 and arm64; both macOS runners failed on the test certificates. After the owner made the repository public, the matrix ran again for `cli-v0.1.1`. The certificate fix held, one terminal test needed a macOS wrapper, and run 43857539084 passed the whole of project `cli` from the released files on all four targets ("The runs of 16 November", below).

## The run

- Run: https://github.com/Virabyan99/mykey/actions/runs/43734935509 (`workflow_dispatch`, `jobs=cli-matrix`, `cli_release=cli-v0.1.0`, ref `session-5` at `ab814eb`). It was run once.
- Release: https://github.com/Virabyan99/mykey/releases/tag/cli-v0.1.0. Tag `cli-v0.1.0` = `ab814ebc55d3b960fb58d642a22ce2487270cb57`.
- `SHA256SUMS` tested (each runner checked it before installing):

  ```
  2412bb177158f6d76ce55984cc6bf36b56bee913a601a684d41cc2fe333842d7  mykey-cli-0.1.0.tgz
  d07a6f031eb1f7059bd4907a33dfdce48c5f4002b041ede38ffe4fe5a1bf7f46  install.sh
  ```

- What each job did:
  1. downloaded the release with `gh release download`;
  2. checked it with `sha256sum -c` (or `shasum -a 256 -c` on macOS);
  3. ran `sh rel/install.sh`, which fetched and checked the pinned Node archive of its target;
  4. ran `pnpm exec vitest run --project cli` with `MYKEY_CLI_BIN=$HOME/.local/bin/secrets`, so every CLI process of the suite was the installed launcher on the installer's Node. The JSON report was uploaded as an artifact, `cli-report-<target>`.

## Per target

| Target       | Runner label       | `uname -a`                                                                                                                                                 | Launcher `--version`                                      | Passed | Failed | Job time | Billed minutes (estimate) |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -----: | -----: | -------: | ------------------------- |
| linux-x64    | `ubuntu-24.04`     | `Linux runnervm8axu0 7.0.0-1017-azure #17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux`                          | `secrets 0.1.0 (API major 1; linux-x64; node 24.22.2)`    |     49 |      0 |    1m13s | 2                         |
| linux-arm64  | `ubuntu-24.04-arm` | `Linux runnervm1x7cq 7.0.0-1017-azure #17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 19:06:39 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux`                       | `secrets 0.1.0 (API major 1; linux-arm64; node 24.22.2)`  |     49 |      0 |    1m15s | 2                         |
| darwin-x64   | `macos-15-intel`   | `Darwin sat12-jr307-….local 24.6.0 Darwin Kernel Version 24.6.0: Tue Jul 21 20:50:07 PDT 2026; root:xnu-11417.140.69.711.44~1/RELEASE_X86_64 x86_64`       | `secrets 0.1.0 (API major 1; darwin-x64; node 24.22.2)`   |     16 |     33 |    3m11s | 40 (4 × 10)               |
| darwin-arm64 | `macos-15`         | `Darwin chi22-dq224-….local 24.6.0 Darwin Kernel Version 24.6.0: Sun Oct 11 23:44:11 PDT 2026; root:xnu-11417.140.69.713.47~2/RELEASE_ARM64_VMAPPLE arm64` | `secrets 0.1.0 (API major 1; darwin-arm64; node 24.22.2)` |     16 |     33 |    1m59s | 20 (2 × 10)               |

Billed minutes:

- The run's timing API (`/actions/runs/43734935509/timing`) reported `total_ms: 0` for every job. That figure is not usable.
- The estimate rounds each job up to whole minutes, with macOS counted ten times: about 64 minutes for the run. The other four jobs of the workflow were skipped, as the dispatch input intends.

On macOS the installed launcher ran, named its own target, and ran the pinned Node; `platform.test.ts` and `install.test.ts` passed there. The installer is therefore proven on all four targets.

## Why macOS failed

All 33 failures share one cause. Every TLS connection from the CLI to the suite's test server was refused, and the CLI exited 69 with `the API's certificate is not trusted for this address`. The tests then failed in one of two ways:

- a test that expected another exit code saw 69;
- a test that waited for a child timed out, because none started.

The test server's certificates are made at run time by the machine's `openssl` (`tests/cli/certs.ts`). On macOS that is LibreSSL. It was reproduced with LibreSSL 4.3.1 in a container, using a system config with a `v3_ca` section, as macOS has. LibreSSL differs from OpenSSL 3 in three ways:

1. `x509 -req` signs with SHA-1 unless told otherwise. Node refuses the result with "CA signature digest algorithm too weak".
2. The system config adds `v3_ca` to the authority, which doubles its `basicConstraints`. Node then cannot verify the leaf.
3. It refuses `-days -1`, so the expired certificate cannot be made that way.

The fix is test-only; the release stays `cli-v0.1.0`, unchanged:

- `certs.ts` writes its own config and passes it to every command (`-config` and `OPENSSL_CONF`);
- it names `-sha256` on every signing;
- it signs the expired certificate with `openssl ca` and explicit dates.

How the fix was proven:

- `tests/cli/certs.test.ts` (new) checks the suite's own certificates by handshake: the good one is accepted, other-host is refused with `ERR_TLS_CERT_ALTNAME_INVALID`, and expired with `CERT_HAS_EXPIRED`.
- Its LibreSSL reproduction failed before the fix (`openssl x509 failed`) and passed after it.
- `node scripts/test-cli.ts --release <download of cli-v0.1.0>` then passed 8 files and 52 tests in the Linux container.

## D-24's nine requirements (AGENT-B1)

Each requirement against the tests that prove it, and where they passed from the release:

| #   | Requirement (D-24)                                                      | Test that proves it                                                                                                                                                                                                                       | Linux x64 / arm64     | macOS x64 / arm64 |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------- |
| 1   | The complete current set, with no name list in a configuration file     | `run.test.ts` "the child gets the complete set and nothing of the CLI"; `keys.test.ts` "prints the names one a line in the server's order, with a final newline; exit 0"                                                                  | pass / pass           | pass / pass       |
| 2   | Nothing starts on an incomplete set; non-zero exit with a contract code | `run.test.ts` "nothing starts on anything less than the complete set"; `keys.test.ts` "a wrong count → 65 and stdout is empty"                                                                                                            | pass / pass           | pass / pass       |
| 3   | Only the product API on 443; no path to OpenBao                         | `connection.test.ts` "an http:// URL → 78, …", "an authority the CLI does not trust, another host name, an expired certificate → 69 each, no request", "/v1/version answering 307 to a second server → 69; the second server saw nothing" | pass / pass           | pass / pass       |
| 4   | The credential is kept out of the child                                 | `run.test.ts` "the token is nowhere a child could find it by default"                                                                                                                                                                     | pass / pass           | pass / pass       |
| 5   | Current values only                                                     | `tests/integration/machine/resolve.test.ts` "current values only: after an update resolve returns the new digest" (the API's guarantee, real stores); the CLI has no version parameter                                                    | API-side, all targets | API-side          |
| 6   | The child's exit code; SIGINT and SIGTERM forwarded                     | `run.test.ts` "the child's status is the CLI's: 7 → 7, SIGKILL → 137", "without a terminal each of SIGTERM, SIGINT, SIGHUP and SIGQUIT reaches the child exactly once", "with a terminal, Ctrl-C reaches the child once"                  | pass / pass           | pass / pass       |
| 7   | Never restarts the child                                                | `run.test.ts` "a command that does not exist → 64; a child that exits 1 was started once"                                                                                                                                                 | pass / pass           | pass / pass       |
| 8   | One supported build for macOS and Linux (Windows: refused, D-43)        | `platform.test.ts` "--version names the target, and it is the one the runner claims", "an installed launcher runs the pinned Node"; `install.test.ts` (four cases)                                                                        | pass / pass           | pass / pass       |
| 9   | No pre-release dependency                                               | `cli.test.ts` "the bundle imports node: modules only"; `pins:verify` (no pre-release in the lock)                                                                                                                                         | pass / pass           | pass / pass       |

## Native Windows

The workstation's line from `pnpm run test:cli` (Run 5.7 Task C, 2026-11-15):

```
test:cli: native Windows refused with 78, as it must be
```

## The runs of 16 November

The repository is public since 16 Nov 2026, so the matrix no longer costs Actions minutes (`owner-requests.md`). Three dispatches of `jobs=cli-matrix` for release `cli-v0.1.1` (`SHA256SUMS` `cd9b4c37…` tgz, `51fc0968…` install.sh), each checking the sums, installing and running project `cli` against the installed launcher:

| Run                                                                         | Ref                | linux-x64 | linux-arm64 | darwin-x64        | darwin-arm64 | What it showed                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------ | --------- | ----------- | ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [43855235164](https://github.com/Virabyan99/mykey/actions/runs/43855235164) | `main` (`ae5e3bd`) | 53/53     | 53/53       | 52/53             | 52/53        | The certificate fix holds on macOS (the 33 TLS failures are gone). One case left: "with a terminal, Ctrl-C reaches the child once" timed out waiting for the child, with no output to show why.                                                                                                                                    |
| [43856083484](https://github.com/Virabyan99/mykey/actions/runs/43856083484) | `session-5-macos`  | 53/53     | 53/53       | 48/53 (4 skipped) | 52/53        | The test now says why: BSD `script` exited with `script: tcgetattr/ioctl: Operation not supported on socket`. It needs its own stdin to be a terminal, and the test's stdin is a socket. darwin-x64 also met a connection timeout to a Cloudflare address in another file (a runner network failure) and its report upload failed. |
| [43857539084](https://github.com/Virabyan99/mykey/actions/runs/43857539084) | `session-5-macos`  | **53/53** | **53/53**   | **53/53**         | **53/53**    | On macOS the terminal case runs under Python's `pty.spawn`, which copies a non-terminal stdin to the pseudo-terminal. Linux keeps util-linux `script`.                                                                                                                                                                             |

- **Proof before the third run:** on Linux (WSL Ubuntu, Python 3.14), `pty.spawn` with a socketpair as stdin delivered Ctrl-C to a waiting child exactly once and exited 0. `node scripts/test-cli.ts tests/cli/run.test.ts` passed 14/14 in the Linux container.
- **The CLI did not change:** both fixes are in the tests (`tests/cli/certs.ts` in Run 5.7, `tests/cli/run.test.ts` and `tests/harness/cli.ts` here). The release bytes are the ones above.

| Target       | Runner label       | `uname -a` (run 43857539084)                                                                                                                         | Launcher `--version`                                      |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| linux-x64    | `ubuntu-24.04`     | `Linux runnervm8axu0 7.0.0-1017-azure #17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux`                    | `secrets 0.1.1 (API major 1; linux-x64; node 24.22.2)`    |
| linux-arm64  | `ubuntu-24.04-arm` | `Linux runnervm1x7cq 7.0.0-1017-azure #17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 19:06:39 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux`                 | `secrets 0.1.1 (API major 1; linux-arm64; node 24.22.2)`  |
| darwin-x64   | `macos-15-intel`   | `Darwin sjc20-….local 24.6.0 Darwin Kernel Version 24.6.0: Tue Jul 21 20:50:07 PDT 2026; root:xnu-11417.140.69.711.44~1/RELEASE_X86_64 x86_64`       | `secrets 0.1.1 (API major 1; darwin-x64; node 24.22.2)`   |
| darwin-arm64 | `macos-15`         | `Darwin sjc22-….local 24.6.0 Darwin Kernel Version 24.6.0: Sun Oct 11 23:44:11 PDT 2026; root:xnu-11417.140.69.713.47~2/RELEASE_ARM64_VMAPPLE arm64` | `secrets 0.1.1 (API major 1; darwin-arm64; node 24.22.2)` |

FR-1.51 SPIKE_PASS — `cli-v0.1.1` from the release on Linux x64 and arm64 and macOS x64 and arm64: project `cli`, 53/53 on each target (run 43857539084).
AC-1.37 SPIKE_PASS — the connection refusals (http URL, untrusted authority, another host name, expired certificate, a redirect of the version check) pass from the release on all four targets (run 43857539084).
PO-8 SPIKE_PASS — installer and launcher on all four targets and the full suite on each from the release (run 43857539084); credential setup and replacement rehearsed against staging (`run-5.8.md`, re-run at the Session 5 gate 7/7).
AGENT-B1 SPIKE_PASS — D-44 decided; D-24's nine requirements pass on all four targets (the table above; requirement 5 is the API's, proven on real stores).
