# Consumer setup on a developer's machine

How an application on your own Linux or macOS machine gets its secrets from MyKey at start, with no `.env` file. The CLI `secrets` reads the complete set of one environment and starts the application with it, or starts nothing.

Every shell block marked `<!-- rehearsed … -->` in this file is run, in order (a block marked `rehearsed: provided` is replaced by the test's own equivalent, because its values are the reader's), by `tests/consumers/runbook.test.ts` on a clean Linux machine against staging (`pnpm run test:consumers`). If the file and the product drift apart, that test fails.

- **Needs:** Linux (glibc) or macOS on x86_64 or arm64, `sh`, `curl`, `tar`, and `sha256sum` or `shasum`. Windows is not supported (D-43); WSL is Linux. The repository is public, so step 1 needs no GitHub account: `gh` is one way, `curl` the other.
- **Variables used below:**
  - `SECRETS_API_URL`, `SECRETS_PROJECT`, `SECRETS_ENVIRONMENT`: the service and the environment to read;
  - `APP_DIR`, `APP_START`: your application's directory and the command that starts it.

## 1. Get the release

The CLI release `cli-v0.1.2` (three files) and the launch wrapper `secrets-launch.sh`, which reads the token from a file:

<!-- rehearsed: provided -->

```sh
mkdir -p "$HOME/mykey-release"
gh release download cli-v0.1.2 --repo Virabyan99/mykey --dir "$HOME/mykey-release"
gh api -H "Accept: application/vnd.github.raw" \
  "repos/Virabyan99/mykey/contents/tests/fixtures/consumers/secrets-launch.sh?ref=cli-v0.1.2" \
  > "$HOME/mykey-release/secrets-launch.sh"
```

Without `gh` (`gh: not found`), the same four files with `curl`:

```sh
mkdir -p "$HOME/mykey-release"
cd "$HOME/mykey-release"
for f in install.sh mykey-cli-0.1.2.tgz SHA256SUMS; do
  curl --proto '=https' -fsSLO "https://github.com/Virabyan99/mykey/releases/download/cli-v0.1.2/$f"
done
curl --proto '=https' -fsSL -o secrets-launch.sh \
  "https://raw.githubusercontent.com/Virabyan99/mykey/cli-v0.1.2/tests/fixtures/consumers/secrets-launch.sh"
```

## 2. Check the files

Both lines must say `OK`:

<!-- rehearsed -->

```sh
cd "$HOME/mykey-release"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi
```

## 3. Install

`install.sh` checks the CLI archive against its own pinned sum. It downloads the official Node it needs from nodejs.org and checks that against a pinned sum too. It writes only `~/.local/share/mykey/cli/<version>/` and the launcher `~/.local/bin/secrets`, and needs no root. `sh "$HOME/mykey-release/install.sh" --uninstall` removes it again.

<!-- rehearsed -->

```sh
sh "$HOME/mykey-release/install.sh"
install -m 0755 "$HOME/mykey-release/secrets-launch.sh" "$HOME/.local/bin/secrets-launch.sh"
```

## 4. Put the CLI on `PATH`

For this shell session. Add the same line to your shell profile yourself if you want it for every session; the installer edits no profile.

<!-- rehearsed -->

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## 5. Name the service and the environment

`SECRETS_PROJECT` is the project's id and `SECRETS_ENVIRONMENT` the environment's name. `APP_START` is the command that starts your application, and `APP_DIR` is the directory it starts in. The values below are examples: replace every one.

- **The project's id** is in the workspace's address, on any screen of the project: `…/o/<organization id>/p/<project id>/e/<environment id>`. Take the segment **after `/p/`**. Either of the other two (the organization's, or the environment's) answers `denied … 404 (code: not_found)`.
- **The environment** is its name, as the workspace shows it (`development`), not the id after `/e/`.
- **No application yet?** Leave `APP_DIR` and `APP_START` out, and in step 9 start a command that prints only the names it was given (below).

<!-- rehearsed: provided -->

```sh
export SECRETS_API_URL="https://mykey.example"
export SECRETS_PROJECT="<project id>"
export SECRETS_ENVIRONMENT="development"
export APP_DIR="$HOME/my-app"
export APP_START="npm start"
```

## 6. Check the endpoint

`secrets --version` makes no request. The second line is the service's own answer, with no credential:

<!-- rehearsed -->

```sh
secrets --version
curl --proto '=https' -fsS "$SECRETS_API_URL/v1/version"
echo
```

## 7. Issue a machine token

The owner issues a token for the environment, with a name and a lifetime: on the workspace's Machine credentials screen, as "Issue" in `docs/runbooks/machine-credentials.md` describes. The token is shown once. Copy it now: the service stores no copy.

## 8. Store the token

Run the block, paste the token, press Enter, then Ctrl-D. The token is typed into `cat`, not into the shell, so it is in no shell history and no command's arguments. The file is readable by you alone.

**The pasted token stays on the screen.** Do not copy that terminal into a chat, a ticket or a screenshot. To keep it off the screen, type `stty -echo` before the block and `stty echo` after it. A token that was shown to anyone is revoked and replaced (`machine-credentials.md`).

<!-- rehearsed: stdin -->

```sh
( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )
```

## 9. Start the application

`secrets-launch.sh` refuses a token file that is a symbolic link, is not yours, or can be read by anyone else. It passes the token to `secrets run`, which reads the complete set and starts the application with the secrets as environment variables. The token itself stays out of the application's environment and arguments. If the set cannot be read completely, nothing starts, and the exit code says why: 77 means the token is not accepted, 69 the service cannot be reached.

<!-- rehearsed: background -->

```sh
cd "$APP_DIR"
secrets-launch.sh -- sh -c "exec $APP_START"
```

Without an application, a command that lists the names it was started with, never a value. The environment's secret names appear among the shell's own:

```sh
secrets-launch.sh -- sh -c 'echo "started; these names are set:"; env | cut -d= -f1 | sort'
```

## 10. Check

From another terminal, check that the application has its configuration, in whatever way the application offers. The fixtures answer `GET /check` with the names and digests they received, never a value:

<!-- rehearsed -->

```sh
curl -fsS "http://127.0.0.1:3000/check"
echo
```

## Rotate the token

1. Issue a second token (step 7).
2. Replace the file in place, the same way as before:

   <!-- rehearsed: stdin -->

   ```sh
   ( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )
   ```

3. Stop the application (Ctrl-C in its terminal) and start it again:

   <!-- rehearsed: background -->

   ```sh
   cd "$APP_DIR"
   secrets-launch.sh -- sh -c "exec $APP_START"
   ```

4. Check (step 10), then revoke the first token ("Revoke" in `machine-credentials.md`). From then on it is refused (`secrets keys` with it exits 77).

## After a restore

A restore of the service treats every token issued before it as unknown. The operator runs `ops reconcile-credentials` for each environment, and the owner issues new tokens. Your part is the same as rotating: replace the file with the new token and restart the application (steps 2 and 3 of "Rotate the token").

## Where the credential is and who can read it

- The token is in `~/.config/mykey/machine-token`, mode 0600, readable by you alone and by root.
- While the application runs, the token is also in the environment of the `secrets` process. Any process running as you can read that process's environment (`/proc/<pid>/environ` on Linux).
- `secrets run` keeps the token out of the application's environment and arguments. It does nothing more than that.

## Limits

- The service replaces your application's dotenv files. It does not remove the need to protect this one credential.
- Whoever can act as your user on this machine can read the token and every secret the application received.
- The CLI reads the set once, at start. A changed secret reaches the application at its next start.
- The token's lifetime ends at the time chosen at issue. Rotate it before then.
