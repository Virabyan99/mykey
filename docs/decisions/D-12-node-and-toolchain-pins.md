# D-12 — Node line and toolchain pins

**Date:** 2026-11-10

**Status:** DECIDED by the executing agent in Run 1.3 (planner decisions P-1, P-2, P-3, P-4)

## Decision

1. **Node 24 LTS ("Krypton"), pinned at 24.22.2** in `.node-version` and `infra/dependencies.lock.json`. Node 26 LTS is not used: no pinned dependency needs it (the strictest requirement is `>=22.12` from pg-boss and Vitest), and Node 26 needs `libatomic` on Linux hosts (Doc 06 §1.1).
2. **Repository scripts are `.ts` files run directly by `node`** (built-in type stripping, no flag, no warning on Node 24). TypeScript is configured with `erasableSyntaxOnly`, so nothing needs a transpiler. The `tsx` fallback was not needed.
3. **Tools:** ESLint 10 + typescript-eslint (strict, type-checked), Prettier, Vitest, fast-check. Vite+ stays a candidate only.
4. **TypeScript 6.0.3, not 7.0.2.** TypeScript 7 is the current stable release, but the newest typescript-eslint (8.72.2) declares `typescript >=4.8.4 <6.1.0`. Linting with type information is worth more today than the newer compiler.
5. **Zod 4.6.7 has `z.toJSONSchema` with `target: "draft-2020-12"`** (checked by running it), so the OpenAPI builder of P-9 needs no `zod-openapi` fallback.
6. **Runtime packages that no workspace uses yet** (Hono, Better Auth, pg-boss, React, TanStack Query, Scalar) are pinned now in the pnpm `catalog:` and in the lock; workspaces adopt them with `catalog:` later.
7. **Container images come from Docker Hub by `@sha256:` digest**; Actions by 40-hex commit SHA. `pnpm run pins:verify` (part of `pnpm run check`) fails on a range, a pre-release, a tag-only image, a tag-only Action, or any disagreement between `package.json`, the catalog, `.node-version` and the lock.

## Notes on individual pins

- **Better Auth 1.7.19.** Doc 06 §1.1 names 1.7.18 as the candidate; 1.7.19 is the newer stable patch, no advisory.
- **Traefik 3.7.17.** Version 3.7.18 was published on GitHub on 10 November 2026 (today) but its image is not on Docker Hub yet; 3.7.17 is pinned and 3.7.18 is reviewed at the Run 2.5 pin check.
- **PostgreSQL 18.6, OpenBao 2.7.2, Restic 0.19.1, gitleaks 8.30.1, Trivy 0.76.2.**
- **Trivy's vulnerability database** is downloaded at scan time and cannot be pinned by digest; it is data, not code. The scanner binary itself is pinned.
- **Advisories:** every npm pin was checked against the GitHub Advisory Database on 10 November 2026 (`gh api "/advisories?ecosystem=npm&affects=<name>@<version>"`, verified to return results for a known-vulnerable control package); no pinned version has an advisory. The four Actions repositories have no published security advisory.

## What it changes

- `engines.node` is `>=24.18.0 <25`, wider than the pin, because the owner's workstation has Node 24.18.0. **Node 24.18.1 and 24.22.1 were security releases**, so the workstation should be updated to 24.22.2; CI and the servers use the exact pin.
- `@eslint/js` and `@types/node` are in the lock in addition to the packages the plan lists; `@types/pg` is in the catalog.

## Amends

Nothing in Documents 04 or 06. Fills in the "candidates" of Doc 06 §1.1 and Doc 10 Run 1.3.
