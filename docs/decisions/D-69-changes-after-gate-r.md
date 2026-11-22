# D-69 — What may change after Gate R

**Date:** 2026-11-22

**Status:** DECIDED (the owner answered "yes" at the session start, 22 Nov 2026; `docs/evidence/session-9/owner-requests.md`, answer 1). Applied in Run 9.0 Task I Step 1, the diff check of `host-v0.8.1..HEAD`.

## Context

Gate R (D-67) signed `host-v0.8.1` for controlled use. The owner also asked for the workspace's UI and UX to be reworked in Session 9 (`walkthrough.md`), and Session 8's review left the restore Mediums R4-2, R4-3, R4-4, R4-7 and R4-10 open. Either change makes production serve a build that Gate R did not sign. So the conditions under which that is still the signed product have to be written down before the change, not argued after it.

## Decision

1. **May change without a new authorization:**
   - `apps/web`;
   - `WEB_ROUTES` (`packages/contracts/src/web-routes.ts`), for P-161's two page paths only;
   - the restore's code (`apps/ops/src/commands/restore*` and its exports, `scripts/host-restore.ts`, `scripts/host-custody.ts`, the restore part of `scripts/host.ts`);
   - host files (`infra/hosts`), scripts, tests, test tools (`tools/`) and documents.
2. **Stops the run and goes to the owner:** anything else under `apps/`, `packages/` or `infra/compose`, any API route, contract body or migration, and any pin of a product image.
3. **The new workspace reaches production only if:**
   - the diff holds only the paths of point 1;
   - full CI, the canary scan and a fresh-context review are green;
   - the owner's task test passes.

   Otherwise production opens on `host-v0.8.1` (valve 0), and the new page waits for Stage 2.

4. **Gate F's dossier names the release that served real data.**

## Consequences

- **The diff check of Run 9.0 Task I.** Besides the paths of point 1, it found `.gitignore`, `CLAUDE.md`, `tsconfig.root.json`, `vitest.config.ts` and one root devDependency, `axe-core` 4.14.0, with `pnpm-lock.yaml` and its lock entry. The devDependency is test-only: the browser accessibility test injects it, and it is never bundled. All of these were held to be within point 1.
- **Connect an application** bundles the consumer runbooks as a generated module (`scripts/web-runbooks.ts`), because importing the Markdown files would change `apps/api/Dockerfile`.
- **The field day** (Run 9.6) runs on the host from `infra/hosts`, not as an `apps/ops` command, for the same reason.
