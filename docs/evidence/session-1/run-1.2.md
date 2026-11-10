# Run 1.2 — Repository and toolchain

## What was done

- pnpm workspace with twelve packages (`@mykey/api`, `provisioner`, `web`, `cli`, `ops`, `contracts`, `db`, `auth`, `openbao`, `operations`, `audit`, `probe`) plus `@mykey/tests`; each exports `./src/index.ts`, which is `export {};`.
- Strict TypeScript (`tsconfig.base.json`): `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `composite`. Root `tsconfig.json` references the twelve workspaces and `tsconfig.root.json`, one project that type-checks `scripts/`, `tests/`, `infra/` and `vitest.config.ts`.
- ESLint flat config (typescript-eslint strict + stylistic, type-checked), Prettier, Vitest with three projects (`unit`, `integration`, `cloud`) and `passWithNoTests: false`.
- Private GitHub repository `Virabyan99/mykey` created (OWN-1 default name; no owner reply yet).

## Commits

- this commit: chore: pnpm monorepo skeleton with strict TypeScript, lint, format, tests

## Commands and results

| Command                                                     | Exit | Proof line                                                               |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------ |
| `pnpm test` before the workspaces existed                   | 1    | `Tests 3 failed \| 1 passed (4)` (ENOENT `apps\api\package.json`)        |
| `pnpm install --frozen-lockfile`                            | 0    | `Done in 432ms using pnpm v10.20.0`                                      |
| `pnpm run check`                                            | 0    | `All matched files use Prettier code style!`, eslint and `tsc -b` silent |
| `pnpm test`                                                 | 0    | `Tests 4 passed (4)`                                                     |
| `pnpm exec vitest run --project integration`                | 1    | `No test files found, exiting with code 1`                               |
| `gh repo create mykey --private --source . --remote origin` | 0    | `https://github.com/Virabyan99/mykey`                                    |

## Deviations and decisions

- **TypeScript 6.0.3, not 7.0.2.** The newest typescript-eslint (8.72.2) declares `typescript >=4.8.4 <6.1.0`, so TypeScript 7 cannot be linted with type information yet. Recorded in D-12 (Run 1.3).
- **`@eslint/js` added** to the dev tools the plan lists: ESLint 10 ships its recommended rule set in that package.
- **`@types/node` 24.19.2**, matching the Node 24 line rather than the `latest` tag (26.x).
- **One root TypeScript project** (`tsconfig.root.json`) for `scripts/`, `tests/` and `infra/` instead of a `tsconfig.json` under `tests/`: tests import repository scripts by relative path, which TypeScript only allows inside one project when import extensions are rewritten.
- `docs/plans/` and `.superpowers/` are in `.prettierignore` in addition to the plan's list, so session plans are never reformatted.
- `pnpm install` works inside OneDrive (no file-lock or junction errors), so the folder was not moved.
- Branch protection is not available for private repositories on the GitHub free plan; none is configured and nothing works around it.

## Open issues

- OWN-1 reply still outstanding; defaults now apply (repository `mykey`, P-records absent, decisions assumed).
