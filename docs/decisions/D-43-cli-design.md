# D-43 — The CLI

**Date:** 2026-11-15

**Status:** DECIDED in the Session 5 plan (P-96, P-97), recorded by the executing agent. Run 5.5 wrote the connection, the version check and `keys`; Run 5.6 added `run` and `export`.

Evidence:

- `tests/unit/cli/{args,errors,config,guard,token,validate,child-env,export-target}.test.ts`;
- `tests/cli/{connection,keys,cli,run,export}.test.ts` (run by `pnpm run test:cli`);
- `tests/integration/machine/cli-client.test.ts`;
- `tests/staging/cli.staging.test.ts`;
- `docs/evidence/session-5/{run-5.5,run-5.6}.md`.

## Shape

- **One file.** `apps/cli/src` is bundled by esbuild 0.28.2 into `apps/cli/dist/secrets.mjs`: ESM for the pinned Node, no minification, no source map, a `#!/usr/bin/env node` banner, and the version from `package.json` compiled in. The file imports only `node:` modules. It bundles `@mykey/contracts` (limits, names, schemas, `API_MAJOR`) and zod. `cli.test.ts` checks the imports.
- **Commands** (Doc 04 §7):
  - `secrets keys`;
  - `secrets run [--override] -- <command> [args…]`;
  - `secrets export --output <new-file>`;
  - `secrets --version`.

  Selectors are `--project <id>` and `--env <name>`, or `SECRETS_PROJECT` and `SECRETS_ENVIRONMENT`, and a flag wins. The project must be a UUID and the environment must match the environment-name rule, so nothing typed can reshape the request path. The plan wrote `--out`; Doc 04 says `--output`, and Doc 04 wins.

- **The order in `main`**, the same for every command:
  1. the runtime guard;
  2. the arguments;
  3. the API URL and the selector;
  4. the token;
  5. `GET /v1/version`;
  6. the command.

  Nothing touches the network before step 5. `--version` stops after the arguments and makes no request.

## Trust

- **The API URL** comes from `SECRETS_API_URL`, else from `${XDG_CONFIG_HOME:-$HOME/.config}/mykey/config.json`. The file holds exactly `{"apiUrl": "https://…"}`, belongs to the user and is writable by nobody else. The URL must be a bare https origin: no user information, query, fragment (a bare `?` or `#` included) or path. Anything else is `78 unsupported`.
- **The token** comes from `SECRETS_MACHINE_TOKEN`, or from the whole of stdin with `--token-stdin` (`keys` and `export` only). One trailing line ending is dropped. It must be 1 to 4,096 bytes of `A-Za-z0-9._-`. No flag or argument ever carries a token: `--token`, `--token=…` and a bare token are usage errors whose text names no argument. Two sources or none are `64`.
- **The guard** refuses these with `78`, before anything else:
  - native Windows, and any platform outside the four targets;
  - a Linux without glibc;
  - `NODE_TLS_REJECT_UNAUTHORIZED` with any value but `1`;
  - `NODE_OPTIONS` (even empty) and `NODE_USE_ENV_PROXY`;
  - an `execArgv` carrying `--require`/`-r`, `--import`, `--loader`, `--experimental-loader`, `--inspect*` or `--insecure-http-parser`.

  `NODE_EXTRA_CA_CERTS` is allowed: it adds trust and removes none. _(Reversed by D-68, Run 8.6: it is refused with the other trust settings, and the CLI's own authority is `SECRETS_CA_FILE`.)_

- **The boundary.** These checks stop settings a user or a script left on by mistake. A launcher that is already hostile (one that controls the Node binary, the file system or the process before the CLI starts) cannot be made safe by JavaScript. The installer and the consumer runbooks say so (Runs 5.7, 5.8).

## Transport

- `node:https` directly, not `fetch`, which follows redirects and hides the socket.
- One request per call on its own socket (`agent: false`), with `rejectUnauthorized: true` written out. There is no proxy.
- Each call has a total deadline: 30 s for `version` and `keys`, 150 s for `resolve`.
- The body is read to its end into one buffer, capped at the complete-response limit plus 64 KiB.
- **No redirect is followed.** A 3xx is `69`, and its `location` is never read. A redirect of `/v1/version` therefore reaches no second server. A redirect of `keys` arrives after the one credentialed request, to the API itself, and is refused.
- **The version comes first, without a credential.** Another `apiMajor` is `76`; a body that is not the version schema is `65`. The client also checks the version itself before its first credentialed call, so a caller that skips `main` cannot skip the check.
- The headers sent are `authorization: Bearer …` (machine routes only), `accept: application/json`, `accept-encoding: identity` and `user-agent: secrets/<version>`.

## Responses

- **A body is used only when it is provably whole.** Each of these failures is `65`, and no message quotes the body:
  - the status is not 200;
  - the content type is not `application/json`;
  - the body has a `content-encoding`;
  - `content-length` is absent or differs from the bytes read;
  - the JSON does not parse;
  - the body fails the contract's strict schema, or `complete` is not `true`;
  - `count` differs from the entries;
  - `apiMajor` is not the CLI's;
  - a name repeats, or breaks the name rule.

  A body cut at a JSON boundary that still parses fails on its length.

- **Refusals.** A status with the contract's error envelope gives the category of its status and code, with the server's code and request id. Without an envelope, the status alone decides, with `code: none`.
- **Exit codes** (Doc 04 §7):
  - 64 usage;
  - 65 malformed;
  - 69 unavailable: network, TLS, 3xx, 5xx, `environment_changed`, `key_under_review`, `quarantined`;
  - 73 export target;
  - 75 capacity: 429, 503 `busy`, 507;
  - 76 incompatible: another API major, or a 400 (the API refuses what this CLI sends);
  - 77 denied: 401, 403, 404;
  - 78 unsupported.
- **The stderr line** is exactly one: `secrets: <category>: <text> (code: <code or none>, requestId: <id or none>)`. An error that is not the CLI's own prints no message, only `unavailable`.
- **`keys`** prints the names one per line in the API's order, with a final newline, and nothing unless the whole answer passed.

## `run` (FR-1.48, FR-1.49)

- **The order:** the common order (the token from the variable only; `--token-stdin` is refused for `run`, and `run` never reads stdin) → `resolve` and the validator → the child's environment → the size check → the signal handlers → `spawn` without a shell, stdio inherited → the references to the entries and the token are dropped → wait. Nothing is written to disk; there is no cache and no second request.
- **The child's environment** is the parent's without every `SECRETS_*` variable, plus the set.
  - A secret whose name is already set is `64` unless `--override`; with it the secret wins.
  - A reserved name, or a value holding a NUL, is `65` in both modes: the answer is wrong, not the user.
- **Size**, refused before the spawn with `75`:
  - on Linux, one `NAME=value` string or argument above 128 KiB (`MAX_ARG_STRLEN`);
  - on both platforms, a total of strings and their pointers above three quarters of `getconf ARG_MAX`.

  `E2BIG` from the spawn is the same category. A command that cannot be found or executed is `64`; any other spawn failure is `69`.

- **Signals.**
  - `SIGTERM` is always forwarded, once per receipt.
  - `SIGINT`, `SIGQUIT` and `SIGHUP` are forwarded only without a controlling terminal. With one, the terminal has already signalled the foreground group, the child among them, and the CLI only waits.
  - The child stays in the CLI's process group. A signal before the spawn starts nothing and exits `128 + n`. The child is never started twice.
- **Status:** the child's status, or `128 + n` when it died by a signal.
- **Streams.** The bundle reaches `process.stdin`, `stdout` and `stderr` only when it uses them, so descriptors 0–2 reach the child as the CLI got them.

## `export` (FR-1.50)

- **The order:** the common order → `resolve` and the validator → the dotenv text in memory (the codec's canonical writer; an entry it refuses is `65`) → the target check → create → write → `fsync` → close → `fsync` of the directory → one stderr line that the file holds plaintext secrets → exit 0.
- **The target check** (`73` on each):
  - every component of the directory exists, is a directory and is not a symbolic link;
  - the directory belongs to the user and is not writable by group or others;
  - nothing exists at the target, whatever it is (`lstat`).
- **Creation:** `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with mode `0600`, then `fstat`: a regular file of the user with no group or other bit. Its device and inode are remembered. There is no `chmod`, ever, so a umask of 277 gives a working `0400` file.
- **Cleanup:** any failure after the creation `lstat`s the path.
  - When the device and inode are the remembered ones, the file is unlinked.
  - When they are not, nothing is deleted, and the line says `cleanup required: <path>` (the path only).

  The exit is `73` either way.

- **The boundary.** Directory trust is explicit. The portable Node implementation does not claim to defend against an attacker who controls the parent directory while the CLI runs.

## Proof (P-97)

1. **Project `cli`** runs the CLI as a child process against `tests/cli/server.ts`. That is a local HTTPS server with certificates made at run time by `openssl`: an authority, a good certificate, one for another host name, and one that has expired. Its answers are checked against the contract's schemas, and a test can damage single answers. It records only whether an `Authorization` header came, never its value. `runCli` fails when a token given to the child comes back on stdout or stderr.
2. **`pnpm run test:cli`.**
   - On Linux and macOS it runs the project natively.
   - On Windows it first checks that the bundle exits `78` naming Windows. It then makes the certificates on the host and copies the working tree and the certificates into a Docker volume. It installs with a cached store and runs the project in `node:24.22.2-bookworm-slim` (pinned by digest as `images.node-glibc`).
   - The Alpine image cannot host the CLI, because the CLI refuses a Linux without glibc. The Debian image has no `openssl`, which is why the certificates are made on the host.
3. **Real stores.** `tests/integration/machine/cli-client.test.ts` imports the CLI's own client and runs it against the fixture's real API. Every body passes the CLI's validators, and the digests equal the owner's export. A revoked token, a foreign path and a held slot come back as `denied`, `denied` and `unavailable`, each with the server's request id.

4. **Staging.** `tests/staging/cli.staging.test.ts` runs the CLI process against the deployed API through the public name. On the Windows workstation it runs in the glibc image, with the environment passed to `docker run` by name only (`tests/harness/cli-linux.ts`).
   - `keys` printed the ten names.
   - `run` started a child whose value digests equalled the owner's export, with no `SECRETS_*` variable.
   - `export` wrote a `0600` file with the same digests.
   - After the revocation, `run` and `keys` exited `77` with an empty stdout.

With `MYKEY_CLI_BIN` set, layer 1 tests that binary instead of the bundle. This is how the matrix tests the installed artifact (Run 5.7).

The process-group scan of Review focus 5 reads `/proc/<pid>/cmdline` on Linux (the glibc image has no `ps`) and `ps -o args= -g` on macOS. The terminal case runs the CLI under `script`, with `exec` so that no shell stands between the terminal and the CLI.

## Why

- The CLI's whole world is HTTP. The test server lets each failure of that world be produced on purpose, and the real stores are met in layer 3 and on staging.
- Refusing before sending is the only way the token cannot reach the wrong place. Every refusal of the connection comes before the bearer is written to a socket.
