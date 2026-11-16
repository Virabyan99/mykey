# Run 5.9 — Contract, reference and carried minors

**Result: DONE on 16 Nov 2026.** What was built:

- **The document:** `GET /v1/openapi.json` answers the generated document, reduced to the operations this build handles.
- **The reference:** `GET /v1/reference` answers one self-contained HTML page built on Scalar.
- **Access:** both routes are for the owner and the admins of the process's organization, with a complete session. Everyone else gets the hidden 404.
- **The capture:** in Chromium, the page makes exactly one request, the document itself. It attempts no third-party request, causes no policy violation and makes no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` call.
- **Compatibility:** `contracts:check` now fails on any break of `packages/contracts/openapi/baseline-v1.json` while `API_MAJOR` is 1.
- **Carried minors:** M-2 and M-6 are closed.

Commits: `ed38ff7` (contract), `737d43d` (Task A), `24f851b` (Task B), `24c7876` (Task C), `029b37d` (Task D), and this note. Decision: D-45.

- **Contract (`ed38ff7`):**
  - New action `reference.read`: owner and admin are allowed; a member is hidden, so the route is not revealed to them.
  - `reference.get` answers `200` as the raw kind `html-document`; `openapi.get` answers `200` with an object. Both list `not_found` and `dependency_unavailable`.
- **Task A, the document and no passthrough (`737d43d`):**
  - **Service scope:** a human route with an action and no `:org` is authorized against the process's own organization (`deps.bao.organizationId()`). When there is none, the answer is 503.
  - **The served document** is computed once at start from the handlers this build has. Unused schemas and `servers` are dropped. The committed `openapi.json` stays complete: it is the contract.
  - **Every listed operation reaches a handler.** `beforeHandler` reports `handled` for this; each probe stops at the handler's door, so nothing is created or read.
  - **No passthrough:** OpenBao-shaped aliases, a method override, `X-Vault-Token` and `X-Vault-Namespace: root` reach no handler and add nothing to OpenBao's audit device.
  - **`scripts/contracts-compat.ts`** lists the breaking changes between two documents: removed path, method, response field or enum value; a request field newly required; a type that narrows.
- **Task B, the page (`24f851b`):**
  - The page holds Scalar's standalone build of `@scalar/api-reference` 1.77.0 inline, the served document as a JSON data block, and a start script that switches off request execution, the client, telemetry, default fonts, developer tools and the MCP entry.
  - Headers are exactly those of P-101. The policy hashes are the SHA-256 of the two inline scripts as served.
  - `pnpm run reference:asset` copies the build. The Dockerfile's `reference` stage puts only `scalar.js` and `scalar.json` into the image.
  - Without the asset the route answers 503, and the process logs `reference_asset_missing` once.
- **Task C, the capture (`24c7876`):**
  - Project `browser`: Playwright 1.64.1, Chromium 156.0.8078.4 (revision 1248).
  - **One-time setup:** `pnpm exec playwright install chromium`, once per workstation. `pnpm install` does not install the browser. `pnpm run test:browser` runs the project; CI does not.
  - **The capture file:** `docs/evidence/session-5/reference-capture.json`.
- **Task D, carried minors (`029b37d`):**
  - **M-2:** an `unchanged` entry is compared again under the lock with its index row. When the key moved, the entry is `conflict`, at apply and at resume.
  - **M-6:** the `Idempotency-Key` description says a rejected request is retried with a new key.
  - **Baseline:** `baseline-v1.json` is written.
- **The auth component's route inventory** (FR-1.52) is Session 3's `auth:contract:check`. This run changed nothing there.

FR-1.52 SPIKE_PASS — `/v1` product routes with an OpenAPI 3.1 document generated from the runtime schemas. The served document is valid for `@scalar/openapi-parser`, its operation ids equal the handled routes, and every listed operation reaches a handler. Breaking changes against `baseline-v1.json` fail `contracts:check` (`tests/unit/contracts/compat.test.ts`, `tests/integration/reference/document.test.ts`).
FR-1.53 SPIKE_PASS — OpenBao-shaped aliases, method override and Vault headers reach no handler and no OpenBao; the document lists no token administration (`tests/integration/reference/aliases.test.ts`).
FR-1.54 SPIKE_PASS — the document and a read-only Scalar page for a fully authenticated owner or admin only, with no request execution, telemetry, CDN or third-party request. The capture is clean, so Scalar was kept (D-45, `docs/evidence/session-5/reference-capture.json`).
AC-1.22 SPIKE_PASS — the product OpenAPI matches validation; a breaking change is detected; the reference requires role and MFA and cannot execute or reach out. The auth-route inventory is Session 3's `auth:contract:check`; the web mapping waits for Session 7.
PO-10 SPIKE_PASS — Scalar served locally and checked in a browser under the page's policy (zero violations, zero third-party attempts). Under Node's permission model the asset loads with a covering grant, and a refused read answers null, never a crash (`tests/browser/reference.test.ts`, `tests/unit/reference/permission.test.ts`).

## Commands and results

| Command                                                                                                     | Result                                                |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/contracts tests/unit/authz` (contract commit, before/after) | RED 5 → passed                                        |
| `pnpm exec vitest run --project unit tests/unit/contracts/compat.test.ts`                                   | RED (no module) → 8 passed; with the baseline case 9  |
| `pnpm exec vitest run --project integration tests/integration/reference/document.test.ts` (before/after)    | RED 3 (404) → passed                                  |
| the same with `servedDocument` keeping every operation (mutation)                                           | 2 failed                                              |
| `pnpm exec vitest run --project integration tests/integration/reference/page.test.ts` (before/after)        | RED 7 (404) → 7 passed                                |
| the same without the script escaping (mutation)                                                             | 1 failed                                              |
| `pnpm run test:browser` (first)                                                                             | 1 failed: one violation, `script-src` `eval` (below)  |
| the same, after the `jitless` prelude                                                                       | **4 passed**                                          |
| the same with the client buttons on (mutation)                                                              | 1 failed: 9 "Test Request" controls                   |
| the same with `withDefaultFonts` and `telemetry` on (mutation)                                              | 1 failed: 14 font requests, 14 violations             |
| `pnpm exec vitest run --project integration tests/integration/imports` (M-2 RED, then all)                  | 2 failed (`succeeded`, not `partial`) → **33 passed** |
| `pnpm exec vitest run --project unit tests/unit/contracts/openapi.test.ts` (M-6)                            | RED (no description) → passed                         |
| `node scripts/contracts-compat.ts` with a path only in the baseline (mutation)                              | exit 1, `path_removed: /v1/gone`                      |
| `pnpm exec vitest run --project unit tests/unit/reference/permission.test.ts`                               | 2 passed                                              |
| `pnpm exec vitest run --project integration tests/integration/reference …/routes-mounted … tests/…/authz`   | 10 files, 88 passed                                   |
| `docker build … -f apps/api/Dockerfile`; `node scripts/ci-scan.ts images`                                   | built; scan exit 0; package list as before (below)    |
| `pnpm test`                                                                                                 | 73 files, 954 passed                                  |
| `pnpm run check`                                                                                            | exit 0                                                |

## What the runs found

- **Scalar's bundled zod probes `Function("")`.** The first capture had one `securitypolicyviolation` (`script-src`, blocked `eval`). It was not a request. Zod v4 tries a compiled parser once, inside `try`, and falls back when eval is refused.
  - **Fix:** the first inline script now begins with `globalThis.__zod_globalConfig = { jitless: true };`. Zod reads that object before the probe and skips it.
  - **The policy still refuses eval.** `'unsafe-eval'` was not added.
- **The build contains `<!--` and `<script`.** They sit inside a syntax highlighter's grammar and a deprecation message, never `</script`. In the HTML parser's script-data states such text could move where the element ends.
  - **Fix:** each `<` that starts one of these becomes `\x3C`.
  - **Proof:** the test compiles both scripts with `vm.Script`, and the page renders.
- **The image's dependencies grew, though not through this run's stage.**
  - **Cause:** Task A put `@scalar/api-reference` in the workspace, and with it vue. better-auth has an optional peer `vue`, which therefore resolved. A production install then carried vue, `@vue/*`, `@babel/*`, typescript and four helpers: 19 package directories.
  - **Fix:** the Dockerfile removes them as it already removes better-auth's other optional peers. Exact versions are used where the API has another version of the same package (`magic-string`, `estree-walker`).
  - **Check:** the image's `node_modules/.pnpm` listing equals the last image built before this run, except for better-auth's variant hash. The start-up refusal (which loads every module first) is the same.
- **A 4.9 MB build broke the typed lint.** `eslint .` ran out of heap on `apps/api/assets/scalar.js`; the directory is now in the linter's global ignores.
- **M-2: the plan's wording and the specification differ.** The plan says the import "stops"; FR-1.36 reports per key. The existing test for a changed `update` entry expects "that entry conflict, the rest applied, partial".
  - **Ruling:** an `unchanged` entry whose key moved does the same. This is a recorded ruling.
- **A test error caught before green.** `page.test.ts` first passed the hidden 404 comparison vacuously: it called `errorOf` on a parsed body, and `undefined` equalled `undefined`. The test now reads the code from the envelope, and the comparison was seen to hold.

## Not done here

- **Staging** gets this build at the gate (Run 5.10, P-102). The page under the image's `--permission` grant is proven locally only (`permission.test.ts`, and the image's start-up).
- **The browser project is not in CI** (CI minutes). It runs again for a change of the page or of Scalar (D-45).
