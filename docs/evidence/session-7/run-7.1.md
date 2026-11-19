# Run 7.1 — Shell, served by the API, client and error table (D08-S33)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Decisions:** D-58 (test cadence), D-59 (the workspace is a static bundle the API serves on a path table).

## What was done

- **Task A — the API serves a shell (P-134, P-141).**
  - `WEB_ROUTES`, `matchWebRoute` and `webPath` in `@mykey/contracts`: fifteen screens.
  - `apps/api/src/web/shell.ts`: the build is read once at start and checked against its manifest's sha256; the index answers on the paths of `WEB_ROUTES`, an asset by its manifest name, both with the headers of P-141 and `no-store`.
  - The shell registers no route: it answers where the terminal 404 would, after the gate and the source limit. `/metrics`, `/debug`, `/status`, `/dashboard/` and `/v1/anything` keep the JSON 404.
  - The compat check learned two breaks carried from Session 5: `response_status_removed` and `response_field_optional`.
- **Task B — the application (P-135, P-136, P-140).**
  - `apps/web/build.ts` (esbuild 0.28.2) writes an index, one script, one stylesheet and a manifest. The API image has a stage `web`; only `apps/web/dist` reaches the final image.
  - `call(routeId, input)` over `ROUTES`, checked with the route's schema, never retrying. `explain()` has one entry per error code. `stateLabel()` has a word and a shape for every state of the contract. `POLL_DELAYS_MS` is 1 s, 2 s, 4 s, then 5 s up to 120 s.
  - The page: the session from `GET /v1/auth/get-session`; no workspace without a complete session; the scope bar; `session.activity` after a key or the pointer, at most once a minute.
  - `tests/harness/web.ts`: Chromium is started with a resolver rule, so the page really is on the origin the API checks. No header is rewritten.

## Commits

- `a0b2b20` feat(api): the workspace shell on a path table
- `ff9eb51` feat(web): the shell, the contract client and one error table

## Commands and results

| Command                                                                | Result                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/web`                   | 5 files, 143 tests passed (red first: 2 failed)      |
| `pnpm exec vitest run --project unit tests/unit/api/web-shell.test.ts` | 49 passed                                            |
| `pnpm exec vitest run --project integration tests/integration/web`     | 13 passed (red first: 4 failed without the wiring)   |
| `pnpm exec vitest run --project browser tests/browser/shell.test.ts`   | 5 passed (red first: 5 failed against an empty page) |
| `pnpm test`                                                            | 114 files, 1413 tests passed                         |
| `pnpm run check`                                                       | green                                                |
| `docker build --target web -f apps/api/Dockerfile .`                   | built; the manifest names the build argument         |

The browser test found zero policy violations and zero third-party requests. Before its first API call the page requested its document, its script and its stylesheet, and nothing else.

## Deviations and decisions

- **The shell is not a mounted route.** The plan named `mountWebShell`. The shell answers inside `app.notFound`, because `routes-mounted.test.ts` requires every route of the app to be a contract or an auth route.
- **Three of Task A's cases are an integration file** (`tests/integration/web/shell.test.ts`): a closed gate, a missing build and a POST need the real app.
- **The test harness has no workspace by default** (`webDirectory: null`), so no existing suite depends on a local build.
- **No session shows the sign-in screen in place.** P-137 said "to `/sign-in`". The address stays, so signing in leads where the owner was going (D-59).
- **An organization has no name in Stage 1.** The scope bar shows the start of its id and the caller's role.
- **The 429 of the browser test is seeded in `app.rate_limit`** (the session's own counter of the current minute), not by a second API with the product's limits.
- **zod runs `jitless` in the page.** Its compiled parsers would need `unsafe-eval`.
- **The type build of `apps/web` writes to `dist/web-src`,** so `apps/web/dist` holds the bundle only.
- **The plan's test about the CLI's error table was removed:** the CLI has no table per code.

## Open issues

- The bundle is about 760 kB before compression. `known-limits.md` gets the line in Run 7.9.
- `font-src 'self'` is not needed (no font is shipped). P-141 allows tightening it; Run 7.9 decides.
- The sign-in screen has no form yet, and the screens after the scope bar show their title only: Runs 7.2 to 7.8.
- The image's final stage was not built in this run (only the stage `web`); the gate's release build does it.
