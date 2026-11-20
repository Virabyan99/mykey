# D-59 — The workspace is a static bundle the API serves on a path table

**Date:** 2026-11-19

**Status:** DECIDED in Run 7.1 (P-134, P-135, P-136, P-141; Doc 10 Run 7.1; Doc 06 §9; FR-1.52, FR-1.76, FR-1.89). Evidence:

- `docs/evidence/session-7/run-7.1.md`;
- `tests/unit/web/router.test.ts`, `tests/unit/api/web-shell.test.ts`, `tests/integration/web/shell.test.ts`;
- `tests/unit/web/{explain,labels,poll,sources}.test.ts`;
- `tests/browser/shell.test.ts`.

## Context

The owner workspace needs the session cookie, the Origin check and a strict content policy to work without exceptions. A second origin, or a development server in production, would need exceptions to all three. Session 5 also left proofs that depend on a 404: `/metrics`, `/debug`, `/status` and `/dashboard/` must not answer.

## Decision

### One origin, one build

`node apps/web/build.ts` (the pinned esbuild) writes `apps/web/dist`:

- `assets/app-<hash>.js` and `assets/app-<hash>.css`;
- `index.html`, which names those two and holds nothing inline;
- `manifest.json`: the build's name and each file's path, sha256 and content type.

The API image has a stage `web` that runs this build. Only `apps/web/dist` reaches the final image: React and the build tool are never in a runtime `node_modules`.

### The API serves it from memory

At start the API reads the manifest and its files once and checks each sha256 (`loadWebShell`). It then answers:

- the index for a `GET` whose path matches `WEB_ROUTES` (`packages/contracts/src/web-routes.ts`), the same table the page's router uses;
- `GET /assets/<file>` for a file of the manifest.

A request path is never joined to a directory. The shell registers no route: it answers where the terminal 404 would, after the gate and the source limit. Every other path keeps the JSON 404.

Without a build, or with a file that does not match its sha256, those paths answer 503 `dependency_unavailable` and the API writes one log line `web_shell_missing` at start.

### Headers

Every answer of the shell carries:

```text
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: DENY
cross-origin-opener-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=()
cache-control: no-store
```

The policy allows no code from text. zod would try to compile its parsers, so the page sets zod's `jitless` before any parse (`apps/web/src/api/zod-setup.ts`); the browser test proves zero policy violations.

### What the page is built from

- React function components and one stylesheet with system fonts; light and dark by `prefers-color-scheme`.
- A router of the project's own over `WEB_ROUTES`: `usePath`, `navigate`, `Link`.
- TanStack Query for metadata only, in memory only (D-60 will record the rules for secrets).
- No router library, no component library, no chart library, no QR code, no Better Auth browser client, no web font, no image.

### The client and the error table

`call(routeId, input)` builds the request from `ROUTES` of `@mykey/contracts` and checks the answer with the route's own schema. It never retries. A result is the body, or a failure:

- `api`: the contract's error envelope;
- `transport`: anything else (a proxy's page, a cut connection, a body that fails its schema).

`explain(failure, { action })` has one entry per error code: a title, a text and the safe next step. The server's message is never shown. No entry for an uncertain outcome invites sending the change again.

### What a missing session shows

Without a complete session the page renders the sign-in screen on every path and requests no workspace data. The address stays as it was, so signing in leads to where the owner was going. (P-137 said "to `/sign-in`"; the address is kept instead, which needs no return address in a URL.)

## Consequences

- The workspace is released and rolled back with the API image: there is no second deployment.
- A new screen needs a row in `WEB_ROUTES`; a path that is not there stays a 404.
- The bundle is about 760 kB before compression (React, TanStack Query, zod and the whole contract). The API does not compress. For one operator on a VPN this is accepted; `known-limits.md` gets the line in Run 7.9.
- An organization has no name in Stage 1: the scope bar shows the start of its id and the caller's role.
