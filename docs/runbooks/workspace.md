# Workspace runbook

The owner workspace is the web page of MyKey (Session 7; D-59, D-60). It is a static bundle that the API serves from its own origin. It holds no data of its own: everything it shows is asked from the API with the owner's session.

## Where it is and how it gets there

- **Address:** the product's origin, on the paths of `WEB_ROUTES` (`packages/contracts/src/web-routes.ts`) and under `/assets/`. Every other path keeps the API's JSON answers.
- **Build:** `pnpm run web:build` writes the bundle. The API image builds it in its own stage, so a release holds it; nothing is built on a host.
- **Start:** the API reads the bundle once, at start, and serves it from memory. A new bundle needs a new release (runbook `deploy.md`).
- **Size:** the script is about 875 kB, 216 kB compressed (measured in Run 7.9).

```sh
pnpm run web:build
pnpm run test:browser   # once per workstation before it: pnpm exec playwright install chromium
```

## When the page does not come

| What the browser shows                             | What it means                                                                                          | What to do                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| JSON with `quarantined`                            | The service gate is closed. A closed host answers JSON on every path, the workspace's included.        | Runbook `service-gate.md`.                                        |
| JSON with `dependency_unavailable` on `/`          | The API started without a bundle. Its log has one line `web_shell_missing`.                            | Deploy a release that was built with `pnpm run host:release`.     |
| JSON with `not_found`                              | The path is not one of the workspace's.                                                                | Open `/`.                                                         |
| A blank page, and the console names a blocked file | The content policy refused something. The bundle loads its own script and stylesheet and nothing else. | Report it with the console's line: it is a defect, not a setting. |
| An old screen after a deploy                       | The tab was opened before the deploy and still runs the old script.                                    | Reload the tab.                                                   |

## What the page will and will not do

- **Sign-in** is a password and then a code from an authenticator app, or a recovery code. There is no sign-up: the first account and every reset come from the operator (runbook `operator-accounts.md`).
- **Enrolment shows the setup key as text**, in groups of four, and as an `otpauth://` address. There is no QR code.
- **After a reset of the authenticator, do not reload** before the new authenticator is set up. A reload loses the hand-over, and a new reset link is needed.
- **A secret is shown for 30 seconds**, a new token for 120 seconds. Both go when the tab is hidden, on a change of address and at sign-out. A token is shown once.
- **Copy puts the value on the clipboard, and an export puts a file on the disk.** Both are outside MyKey from then on: the page cannot take them back.
- **Clearing the page's memory is not erasing it.** The browser may keep freed text until it reuses the space (FR-1.22).
- **On a narrow screen a wide table moves inside its own frame.** The page itself does not move sideways.

## When the page shows a refusal

Every refusal has the same parts, in the same order: what happened, the safe next step, and the ids to quote.

- **Quote the request id and the operation id** to the operator. The request id is in the API's request log and in the audit row of the request.
- **"The outcome is not known"** means what it says. Do not enter the change a second time: open Operations of the environment and read the state.
- **The page settles nothing.** These need the operator, on the host:

| What the page shows                                            | Runbook                  |
| -------------------------------------------------------------- | ------------------------ |
| An operation `uncertain`, a secret or environment under review | `reconciliation.md`      |
| A credential `needs review` or `revoking` that stays so        | `machine-credentials.md` |
| "The secret store is sealed"                                   | `kms-and-unseal.md`      |
| "The service is not open"                                      | `service-gate.md`        |
| A locked or lost account                                       | `operator-accounts.md`   |

The CLI prints the same failure on one line: its category, a text, the code and the request id. It names no next step and no operation id; the page's text for the same code is the fuller one.

## What protects it

- **Headers** on the page and on every file of it: a content policy that allows this origin's script and stylesheet only, no frame (`frame-ancestors 'none'` and `x-frame-options: DENY`), no referrer, `nosniff`, `no-store`.
- **Every change needs this origin.** A request that changes something with a foreign, missing or cross-site origin is refused before the session is read (`tests/integration/authz/origin.test.ts`).
- **A read changes nothing.** No GET of the API changes a row; a refused one writes its denial to the audit log (`tests/integration/browser-security/origin.test.ts`).
- **The proofs in a browser** are `tests/browser/access.test.ts` (keyboard, narrow screen, framing, colours off, refusals) and the files beside it.
