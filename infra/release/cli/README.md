# CLI release

The MyKey CLI ships as a pinned Node package with a tested installer (D-44). It is not a standalone executable: Node's single executable applications are still "Stability: 1.1 - Active development" in the documentation of Node 24.22.2, and macOS x64 is not supported there.

## Make a release

```sh
pnpm run cli:release -- --version 0.1.0          # apps/cli/release/0.1.0/
gh release create cli-v0.1.0 --target session-5 \
  --title "MyKey CLI 0.1.0" --notes "…" apps/cli/release/0.1.0/*
```

- The version must be the one in `apps/cli/package.json`, because the bundle compiles it in.
- The release holds three files:
  - `mykey-cli-<v>.tgz`: `secrets.mjs`, `package.json` and `LICENSE`, the same bytes on every builder;
  - `install.sh`: the version, the archive's sum and the four Node sums of `infra/dependencies.lock.json` written in;
  - `SHA256SUMS`: over the two files.
- **A release is never changed.** A fix is a new version.

## Install on a machine

```sh
gh release download cli-v0.1.0 --repo Virabyan99/mykey --dir mykey-cli
cd mykey-cli && sha256sum -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS
sh install.sh
```

- The installer takes `node-v24.22.2-<target>.tar.gz` from its own directory, or downloads it from `https://nodejs.org/dist/v24.22.2/`. Both archives are checked against the sums in the script.
- It writes `${MYKEY_HOME:-$HOME/.local/share/mykey}/cli/<v>/` and the launcher `$HOME/.local/bin/secrets`.
- It needs no root, and it edits no shell profile.
- `sh install.sh --uninstall` removes what it wrote.
- Supported systems are Linux with glibc and macOS, on x86_64 and arm64. Anything else exits 78 with one line naming what it saw.
