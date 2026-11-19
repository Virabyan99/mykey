# D-60 — A secret in the page lives in one holder and is sent by one function

**Date:** 2026-11-19

**Status:** DECIDED in Run 7.4 (P-138; Doc 10 §4.1 rule 2; Doc 06 §9 and §18.2; Doc 04 §8; FR-1.22, FR-1.23). Evidence:

- `docs/evidence/session-7/run-7.2.md` (the holder and its first users) and `docs/evidence/session-7/run-7.4.md`;
- `tests/unit/web/ephemeral.test.ts`, `tests/unit/web/sources.test.ts`;
- `tests/browser/secrets.test.ts`, `tests/browser/auth.test.ts`.

## Context

The workspace shows values, one-time tokens, an authenticator key, recovery codes and a reset token. Each of them must be gone from the page when the owner stops looking: FR-1.22 names the tab being hidden, a change of address, sign-out and 30 seconds. A rule like this, written again in each of twelve screens, is a rule nobody can review. The query cache is the second risk: an answer that goes through it stays for as long as the cache lives, whatever the screen does.

## Decision

### One holder

`useEphemeral<T>(ttlMs = 30_000, { clearOnHide = true })` returns `[value, set, clear]`. Its rules are the pure function `hold` in `apps/web/src/state/ephemeral.ts`. A held value is forgotten:

- when its time is over;
- when the tab is hidden;
- on every change of address (a link, `navigate`, back and forward);
- at sign-out and whenever the session is dropped;
- when the component is unmounted, because the value is that component's state and nothing else's.

`clearOnHide: false` exists for the three values the owner must leave the tab to use: the authenticator key, the recovery codes and the reset token. They still go on every other event.

A revealed value, the one-time token of a machine credential, the authenticator key, recovery codes and the reset token live only there. They are never in the query cache, a store, the address or a history entry.

### One function

`SECRET_BEARING` (`apps/web/src/api/secret-routes.ts`) lists every request whose body or answer carries a secret:

- routes of the contract: `secrets.reveal`, `secrets.create`, `secrets.update`, `import.preview`, `import.apply`, `import.resume`, `export.create`, `credentials.issue`, `auth.reset.complete`;
- paths of the auth module: `/v1/auth/totp/enroll`, `/v1/auth/totp/activate`, `/v1/auth/recovery/regenerate`, `/v1/auth/change-password`, `/v1/auth/sign-in/email`.

The contract's routes are sent by `callSecret(routeId, input)`: the same request as `call`, kept apart by type and at run time. `call` refuses a route of the list and `callSecret` refuses any other. The auth paths are sent by the functions of `api/auth.ts`. All of them are called from an event handler.

`tests/unit/web/sources.test.ts` reads the workspace's sources and fails when:

- `callSecret`, one of those auth functions, or the id of a listed route is named inside `useQuery`, `useInfiniteQuery`, `useQueries`, `useSuspenseQuery`, `fetchQuery`, `prefetchQuery`, `ensureQueryData` or `setQueryData`;
- any file names `useMutation` (a change is sent by `use-action.ts`);
- `call` is given a listed route.

A control proves the search finds such a call.

### What the owner types

A value typed into a form is in the form's own text area and in no React state. The form is removed after a save and after a version conflict, and what was typed goes with it. After a refusal that changed nothing (507, 503) the form stays, with the value, so the owner need not type it again.

The idempotency key of a write is made from the place, the name and the expected version. It never depends on the value.

### Copy

Copy is a button (`navigator.clipboard.writeText`). Revealing copies nothing. After a copy the page says where the copy went: "The clipboard is outside MyKey: other programs can read it, and MyKey cannot take it back." The value is never in that text, in a notice or in an error.

### The query client

No persister; `staleTime` 30 s; no refetch on focus; no retry; every key begins with `[userId, organizationId]`; the cache is cleared at sign-out, on a 401 and when the account changes.

## Consequences

- A reviewer reads two files to know how a secret is held and sent: `ephemeral.ts` and `secret-routes.ts`.
- A reveal that answers while the tab is hidden is dropped, and the page says so. The owner reveals again; the audit log then has two reveal rows for one look.
- The value field is a plain text area: a value may have several lines, which a password field cannot hold. What the owner types is visible while they type it.
- Clearing state is not a guarantee about the browser's memory (FR-1.22 says so): the engine may keep freed strings until it reuses the space.
- Run 7.10's canary scan reads every storage of the browser after these screens were used, with a control.
