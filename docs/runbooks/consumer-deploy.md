# Consumer setup for a first deployment

How a first consumer application runs in a container on a Linux host with Docker, getting its secrets from MyKey at start. The image carries the CLI and no credential. The token is a file on the host, mounted read-only when the container runs.

Every shell block marked `<!-- rehearsed … -->` in this file is run, in order (a block marked `rehearsed: provided` is replaced by the test's own equivalent, because its values are the reader's), by `tests/consumers/runbook.test.ts` against staging, once for each fixture in `tests/fixtures/consumers/`, on a Linux shell with Docker (`pnpm run test:consumers`).

- **Needs:** Linux (glibc) on x86_64 or arm64 with Docker, `sh`, `curl`, `sha256sum`, and `gh` signed in to GitHub with access to the repository.
- **The application's Dockerfile** ends like the fixtures' (`tests/fixtures/consumers/*/Dockerfile`):

  ```Dockerfile
  COPY mykey-release/ /tmp/mykey-release/
  RUN HOME=/opt/mykey sh /tmp/mykey-release/install.sh \
    && install -m 0755 /tmp/mykey-release/secrets-launch.sh /usr/local/bin/secrets-launch.sh \
    && rm -rf /tmp/mykey-release
  ENV PATH=/opt/mykey/.local/bin:$PATH
  ENTRYPOINT ["secrets-launch.sh", "--"]
  CMD ["<the server command>"]
  ```

- **Variables used below:**
  - `SECRETS_API_URL`, `SECRETS_PROJECT`, `SECRETS_ENVIRONMENT`: the service and the environment;
  - `APP_DIR`: the application's directory, which holds its Dockerfile;
  - `APP_IMAGE`, `APP_NAME`, `APP_PORT`: the image tag, the container name, and the host port that serves the application on 127.0.0.1.

## 1. Get the release

<!-- rehearsed: provided -->

```sh
mkdir -p "$HOME/mykey-release"
gh release download cli-v0.1.2 --repo Virabyan99/mykey --dir "$HOME/mykey-release"
gh api -H "Accept: application/vnd.github.raw" \
  "repos/Virabyan99/mykey/contents/tests/fixtures/consumers/secrets-launch.sh?ref=cli-v0.1.2" \
  > "$HOME/mykey-release/secrets-launch.sh"
```

## 2. Name the application, the service and the environment

<!-- rehearsed: provided -->

```sh
export SECRETS_API_URL="https://mykey.example"
export SECRETS_PROJECT="<project id>"
export SECRETS_ENVIRONMENT="production"
export APP_DIR="$HOME/my-app" APP_IMAGE="my-app:1" APP_NAME="my-app" APP_PORT="8080"
```

## 3. Check the files and fetch Node for the image

The image installs offline, so the official Node archive for the host's architecture goes next to the release files. `install.sh` checks it against its pinned sum during the build.

<!-- rehearsed -->

```sh
cd "$HOME/mykey-release"
sha256sum -c SHA256SUMS
node_version=$(sed -n "s/^NODE_VERSION='\(.*\)'$/\1/p" install.sh)
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
esac
curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$node_arch.tar.gz"
```

## 4. Build the image

<!-- rehearsed -->

```sh
mkdir -p "$APP_DIR/mykey-release"
cp "$HOME/mykey-release/"* "$APP_DIR/mykey-release/"
docker build --quiet -t "$APP_IMAGE" "$APP_DIR"
```

## 5. Store the token on the host

Issue a token for the environment ("Issue" in `machine-credentials.md`). Then run the block, paste the token, press Enter and Ctrl-D. The token goes into `cat`, so it is in no shell history and no argument list:

<!-- rehearsed: stdin -->

```sh
( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )
```

## 6. Run the container

The container runs as the user who owns the token file. The wrapper refuses a file that is not owned by the user reading it, or that has any permission for group or others. The token is mounted read-only. `SECRETS_*` other than the token are plain variables, and `FIXTURE_NAMES` is the fixtures' own setting; give your application its own settings in the same way.

<!-- rehearsed -->

```sh
docker run -d --name "$APP_NAME" --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$HOME/.config/mykey/machine-token,dst=/run/secrets/mykey-token,readonly" \
  -e SECRETS_TOKEN_FILE=/run/secrets/mykey-token \
  -e SECRETS_API_URL -e SECRETS_PROJECT -e SECRETS_ENVIRONMENT -e FIXTURE_NAMES \
  -p "127.0.0.1:$APP_PORT:3000" \
  "$APP_IMAGE"
```

## 7. Check

The fixtures answer `GET /check` with the names and digests they received, never a value. If the set could not be read, the container exits instead: `docker logs "$APP_NAME"` shows the CLI's one line, and its exit code is in `docker inspect`.

<!-- rehearsed -->

```sh
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl -fsS "http://127.0.0.1:$APP_PORT/check"; then echo; exit 0; fi
  sleep 2
done
docker logs --tail 20 "$APP_NAME"
exit 1
```

## Rotate the token

1. Issue a second token.
2. Replace the file **in place**, the same way. A file mounted into a container is followed by its inode, so the file must be rewritten, not replaced by a new file moved over it:

   <!-- rehearsed: stdin -->

   ```sh
   ( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )
   ```

3. Restart the container, so the CLI reads the new token and the complete set again:

   <!-- rehearsed -->

   ```sh
   docker restart "$APP_NAME"
   ```

4. Check (step 7), then revoke the first token ("Revoke" in `machine-credentials.md`).

## After a restore

A restore of the service treats every token issued before it as unknown. The operator runs `ops reconcile-credentials` for each environment, and the owner issues new tokens. On this host, replace the file and restart the container (steps 2 and 3 of "Rotate the token").

## Where the credential is and who can read it

- The token is in `~/.config/mykey/machine-token` on the host, mode 0600. It is readable by its owner, by root, and by whoever can run `docker` on this host: Docker access is root access.
- Inside the container the token is the mounted file, and it is in the environment of the `secrets` process while the application runs. `docker inspect` shows only the file's path.
- The image holds no token: it is built before any token exists, and the token never goes into a build argument.
- `secrets run` keeps the token out of the application's environment and arguments. It does nothing more than that.

## Limits

- The service replaces the application's dotenv files. It does not remove the need to protect this one credential and the host it is on.
- The CLI reads the set once, at start. A changed secret reaches the application at its next start (`docker restart`).
- With `--restart unless-stopped`, a container whose token was revoked keeps restarting and exiting 77. Stop it, or give it a new token.
