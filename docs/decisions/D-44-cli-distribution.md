# D-44 — How the CLI is distributed

**Date:** 2026-11-15

**Status:** DECIDED in Run 5.7 Task A: the first choice failed its proof and the planned fallback was taken (P-98). The release is `cli-v0.1.0`. Evidence:

- `docs/evidence/session-5/run-5.7.md`;
- `docs/evidence/session-5/cli-matrix.md`;
- `tests/unit/release/build.test.ts`;
- `tests/cli/{install,platform,certs}.test.ts`.

## What was read

`https://nodejs.org/docs/v24.22.2/api/single-executable-applications.html`, read on 15 Nov 2026:

- **Stability:** "Stability: 1.1 - Active development".
- **Platforms:** macOS "arm64 only; x64 is not currently supported".
- **Tools outside Node:** the blob is injected with "any tool which can inject resources into the binary" (the page uses `postject`).

The plan's rule was that the first choice fails if its stability is below "Stability: 2", or if one of the four targets is missing. Both conditions hold. A single executable would also break D-24's requirement 9 (no pre-release dependency).

## Decision

The CLI ships as the bundle `secrets.mjs` and runs on the official, pinned Node 24.22.2 of its target.

- **The release** has three files:
  - `mykey-cli-<v>.tgz` holds `secrets.mjs`, a minimal `package.json` and `LICENSE`. Its bytes are the same on every builder: sorted entries, mode 0644 or 0755, uid and gid 0, mtime 0, and the gzip OS byte set to Unix.
  - `install.sh`.
  - `SHA256SUMS` over the other two.
- **Build:** `pnpm run cli:release -- --version <v>` (`infra/release/cli/build-release.ts`). Output goes to `apps/cli/release/<v>/`, which is git-ignored.
- **`install.sh`** (POSIX `sh`; runs under `dash` and macOS's `/bin/sh`):
  - It needs no root and edits no profile.
  - It refuses an unsupported system with exit 78 and one line naming what it saw. Linux without glibc is refused.
  - It checks the CLI archive against the sum written into the script.
  - It takes the Node archive from beside the script, or downloads it from nodejs.org over HTTPS, and checks it against the pinned sum.
  - It unpacks into `~/.local/share/mykey/cli/.install.*` and moves the result into `<v>/` in one step.
  - It writes the launcher `~/.local/bin/secrets`. Running it again changes nothing. `--uninstall` removes what it wrote.
- **Pins:** `binaries.node-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` in `infra/dependencies.lock.json`. `pins:verify` fails when the installer's rendering and the lock file disagree.
- **A release is never changed.** A fix is a new version, and each matrix result belongs to the `SHA256SUMS` it tested.
- **Native Windows is refused** (D-43: exit 78). It is not a release target.

## Which later runs change

None. Run 5.8 installs from these release files.

## Cost if wrong

- The CLI's trust rests on the Node binary next to it. That binary is the official archive, checked against a sum taken from `SHASUMS256.txt` over TLS; the GPG signature of that file was not checked.
- An install is about 50 MB per version, because of the Node archive.
- If the single-executable page later says "Stability: 2" for all four targets, a single binary can replace the bundle and its Node without changing the CLI's behaviour or its test suite.
