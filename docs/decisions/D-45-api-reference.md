# D-45 — The API reference is one self-contained page

**Date:** 2026-11-16

**Status:** DECIDED in Run 5.9 (P-101). Scalar stays: the capture is clean by configuration, so the fallback (a plain HTML listing) was not needed. Evidence:

- `docs/evidence/session-5/run-5.9.md`;
- `docs/evidence/session-5/reference-capture.json`;
- `tests/browser/reference.test.ts`;
- `tests/integration/reference/{document,aliases,page}.test.ts`.

## Decision

`GET /v1/reference` answers one HTML document. It needs nothing else:

- **Scalar's script:** the standalone browser build of the pinned `@scalar/api-reference` 1.77.0, inline.
  - `pnpm run reference:asset` copies it to `apps/api/assets/scalar.js`, with `scalar.json` (package and version). The directory is ignored by Git and by the linter.
  - The Dockerfile's `reference` stage copies only those two files into the image.
  - A process without them answers `503 dependency_unavailable` on this route and logs `reference_asset_missing` once at start.
- **The document:** the served OpenAPI document as a JSON data block (`<script type="application/json" id="openapi-document">`, `<` written as `<`).
- **The start script:** it starts Scalar on the data block, with these options from `@scalar/types` 0.27.0:
  - `hideClientButton`, `hideTestRequestButton`;
  - `documentDownloadType: "none"`, `isEditable: false`;
  - `telemetry: false`, `withDefaultFonts: false`;
  - `showDeveloperTools: "never"`, `showToolbar: "never"`;
  - `persistAuth: false`, `mcp: { disabled: true }`.

  There is no `proxyUrl` and no `fetch` override. An override would hide attempts from the capture; the policy blocks them anyway.

- **The policy:** `default-src 'none'; script-src 'sha256-…' 'sha256-…'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The response also carries `cache-control: no-store`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
- **Escaping:** in both scripts, a `<` that starts `</script`, `<script` or `<!--` becomes `\x3C` before hashing. The build contains `<!--` and `<script` inside literals. Unescaped, they could make the parser end the element in the wrong place.
- **Access:** `GET /v1/openapi.json` answers the generated document reduced to the operations this build handles. Both routes take the action `reference.read`, allowed to the owner and the admins of the process's organization. Everyone else gets the hidden 404.

## What the capture found

1. **One policy violation, `script-src` `eval`.** It was not a request. The zod v4 bundled in Scalar probes `Function("")` once to choose a compiled parser.
   - **Fix:** the first inline script begins with `globalThis.__zod_globalConfig = { jitless: true };`. Zod reads that object and skips the probe.
   - **Rejected:** `'unsafe-eval'` would have weakened the policy.
   - After the fix there are zero violations.
2. **Defaults that reach out**, shown by mutation:
   - With `withDefaultFonts` and `telemetry` on, the page attempts 14 font requests (`fonts.scalar.com`), all refused by the policy.
   - With the client buttons on, 9 "Test Request" controls appear.
   - The tests catch both, so a change of these options cannot pass unnoticed.

The final capture (Chromium 156.0.8078.4, Playwright 1.64.1) shows:

- the only request is `/v1/reference`;
- no third-party request was attempted;
- no policy violations;
- no calls of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`.

## Consequences

- **A Scalar upgrade is a reviewed change.** The `jitless` prelude, the option names and the escaping are tied to 1.77.0. An upgrade reruns `pnpm run test:browser`. That project needs `pnpm exec playwright install chromium` once, and CI does not run it.
- **better-auth's optional peer `vue` now resolves.** Scalar brought vue into the workspace. The image removes vue, and what only vue brings, like the other optional peers, so the image's package list is what it was before.
- **The route list stays frozen (D-15).** No asset route was added.
