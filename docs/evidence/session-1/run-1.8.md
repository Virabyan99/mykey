# Run 1.8 — Strict dotenv codec

## What was done

- `packages/contracts/src/dotenv/`: `parse.ts` (`parseDotenv`), `serialize.ts` (`serializeDotenv`), `warnings.ts` (`loaderWarnings`), `index.ts`; one new line in `packages/contracts/src/index.ts`. All exported from `@mykey/contracts`.
- Unit tests in `tests/unit/dotenv/` (251 tests in 5 files): every accepted and rejected construct of the plan with the exact rule and line, the no-leak test, the canonical writer, four round-trip properties and four fuzz properties with fast-check (1,000 runs each, 5,000 for the entry-shaped fuzz), the warning rules, and the fixture suite.
- Fixtures in `tests/fixtures/dotenv/`: 13 accepted files and 38 rejected files, written byte for byte (CRLF, lone CR, BOM, NUL and an invalid byte included). Every rule has a fixture except `file_too_large`, which the test builds in memory.
- Loader evidence: `tests/fixtures/dotenv-loaders/` (`corpus.json` with 65 synthetic cases in three sets, `node-loader.ts`, `python/check.py`, `python/requirements.txt`) and `tests/integration/dotenv-loaders/loaders.test.ts` (143 tests). The test writes the canonical file of each set, loads it with `@next/env` 16.4.6 and with `python-dotenv` 1.2.4 (installed with `--require-hashes` into `.stack/dotenv-loaders-venv`), and fails when a loader returns a changed or missing value that no warning names.
- `docs/runbooks/dotenv-format-v1.md`: grammar, limits, rejection rules, canonical form, warning rules, and the difference table generated from the loader runs. The integration test fails when the table in the document differs from what the loaders did.
- `tests/package.json` gains `"@next/env": "catalog:"`; `pnpm-lock.yaml` follows. CI: `actions/setup-python` (SHA-pinned, Python 3.12) in the `integration` job.

Registry note for Run 1.10: **FR-1.33, FR-1.34 and FR-1.38 become `SPIKE_PASS`** (proven in isolation by the codec tests and the loader test; not yet on the integrated import and export routes).

## Commits

Branch `run-1.8`, rebased onto `session-1` at `192e083`. Not pushed, not merged.

- `3c50e8a` feat(contracts): strict dotenv parser, canonical writer and loader warnings
- this commit: feat(contracts): strict dotenv codec v1 with loader compatibility evidence

## Commands and results

Run in the worktree `C:/Users/gmpar/mykey-wt/run-1.8` on Windows 11, Node 24.18.0, Python 3.12.7.

| Command                                                                                            | Exit | Proof line                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test -- tests/unit/dotenv`, tests written, no code yet (RED)                                 | 1    | `Tests 219 failed \| 70 passed (289)`; `TypeError: parseDotenv is not a function`                                                      |
| same, after the first implementation                                                               | 1    | `Tests 1 failed \| 288 passed (289)`: the token fuzz accepted too few files to be worth anything (`expected 14 to be greater than 50`) |
| same, with an entry-shaped fuzz generator                                                          | 0    | `Tests 290 passed (290)`                                                                                                               |
| `pnpm run test:integration -- tests/integration/dotenv-loaders`, plan rules (RED)                  | 1    | `Tests 8 failed \| 143 passed (151)`; `nextjs changed DL_42_HASH_AFTER_BACKSLASH and no warning names it`                              |
| `pnpm test -- tests/unit/dotenv/warnings`, tests for the new rules (RED)                           | 1    | `Tests 11 failed \| 298 passed (309)`                                                                                                  |
| same, after extending the rules and correcting two mistakes in the new tests                       | 0    | `Tests 309 passed (309)`                                                                                                               |
| `pnpm test -- tests/unit/dotenv/parse`, test for lazy decoding (RED)                               | 1    | `AssertionError: expected 20002 to be less than 500` (decoder calls for 20,000 invalid lines)                                          |
| same, after decoding on demand                                                                     | 0    | `Tests 310 passed (310)`; a 1 MiB file with an invalid byte on every line went from 3,833 ms to 28 ms                                  |
| mutation check, 17 hand-made mutants of the three source files                                     | 0    | 16 killed at first; the survivor (decoder without `ignoreBOM`) got a test; then 17 of 17 killed                                        |
| `git add tests/fixtures/dotenv` with a fixture named `nul.1.env`                                   | 128  | `error: open("tests/fixtures/dotenv/rejected/nul.1.env"): No such file or directory` (see deviations)                                  |
| both loader scripts in Linux containers (Python 3.12.15, Node 24.22.2)                             | 0    | all six result files `identical to Windows`                                                                                            |
| `pnpm install --frozen-lockfile`                                                                   | 0    | `Done in 1.9s using pnpm v10.20.0`                                                                                                     |
| `pnpm run check`                                                                                   | 0    | `pins: ok`, `OpenAPI document is current.`, `db: migrations match the schema.`                                                         |
| `pnpm test`                                                                                        | 0    | `Test Files 14 passed (14)`, `Tests 345 passed (345)`                                                                                  |
| `pnpm run test:integration`                                                                        | 0    | `Test Files 9 passed (9)`, `Tests 259 passed (259)`, 99 s; 143 of them are the loader tests                                            |
| pinned gitleaks, repository configuration, over a copy of the 72 files this branch adds or changes | 0    | `scanned ~216926 bytes`, `no leaks found`                                                                                              |

What the tests prove:

- **FR-1.33.** Each construct the format rejects has a test with its rule and line: BOM, invalid UTF-8, NUL, lone CR, `export`, single quotes, duplicates, unknown escapes, inline comments, leading and trailing whitespace, backslash, tab and quotes in unquoted values, unterminated quotes, a raw line break inside quotes, text after the closing quote, indented lines, whitespace before `=`, whitespace-only lines, invalid and reserved names, a line without `=`, a 65,537-byte value, 1,001 entries, a file of 1,048,577 bytes. The boundaries on the accepted side are tested too: 65,536 bytes, 1,000 entries, 1,048,576 bytes. `$` is never expanded.
- **No leak.** A rejected file that carries a canary (assembled at run time) in values, bad names and bad lines produces a result whose JSON does not contain it. Only names that passed `checkSecretName` appear. Errors thrown by the writer and warnings carry no value either.
- **FR-1.38.** For generated entry sets (empty values, astral characters, quotes, backslashes, `$`, `#`, CR, LF, tabs, spaces at the ends), `parse(serialize(x))` equals `x` sorted by name and a second `serialize` is byte-identical. The parser never throws on arbitrary bytes, on token soup, or on a valid file with an invalid byte spliced in.
- **FR-1.34.** Over the canonical files of the corpus, no loader changes or drops a value without a warning for that key and loader (last column of the summary table in the runbook: 0 for both loaders). Every warning rule is backed by at least one value the loader really changed.
- **Review focus 1.** Git stores the fixtures with the bytes they were written with (`git ls-files --eol`: 5 files `i/crlf w/crlf`, all `attr/-text`); the suite fails if a file not named `*.crlf.env` contains CRLF or if one that is named so does not.

## Deviations and decisions

1. **Two warning rules the plan did not have, both for `nextjs`.** The loader test failed with the plan's three rules. `@next/env` takes `\"` for an escaped quote wherever it stands. When a value ends with a backslash and the next entry's value starts with optional whitespace and `#`, the loader reads the next line as a comment on the first: the next entry is lost (`DL_42`, `DL_47`, `DL_56` in the table). When that lost value also contains U+2028 or U+2029, the loader starts a new line inside it and text shaped like `NAME=…` replaces the value of another key (`DLX_0_TARGET` and `DLY_0_TARGET` came back as `injected"`). Rule 1 warns the entry that follows a backslash-ended value under exactly that condition; rule 2 warns every key of the file in the second case. Both use the reason `escape`; the `LoaderWarning` type is unchanged. The cases `DL_45`, `DL_49` and `DL_54` show where the rule does not apply and the loader indeed changes nothing. `python-dotenv` 1.2.4 has neither problem.
2. **Fixture names are `reject.<rule>.<n>.env`, not `<rule>.<n>.env`.** `nul.1.env` is the NUL device on Windows. Node could create it; Git for Windows could not add it. A test now refuses any fixture whose name starts with a reserved device name.
3. **`file_too_large` is reported as line 0.** The file is refused before it is split into lines, so no line number would be true. Every other rule uses a line from 1. A schema for issues has to allow 0.
4. **Whitespace directly after `=` is `unquoted_whitespace`.** The plan gives both `invalid_line` (whitespace around `=`) and `unquoted_whitespace` (leading space of a value) for `A= x`. Whitespace before `=` is `invalid_line`; after `=` it is the start of the value.
5. **Whitespace means more than space and tab.** At the ends of an unquoted value, at the start of a line and before `=`, every character either loader would trim counts: JavaScript's `\s` (which includes U+FEFF), U+001C to U+001F and U+0085. Document 04 says "no leading/trailing whitespace"; this is the strict reading.
6. **One issue per line**, the first in a fixed order (runbook, "Rejections"). A duplicate name is reported before a problem with its value, and a name counts as seen even when its first line was rejected. A raw line break inside quotes gives one `raw_newline_in_quotes` issue on the opening line; the lines up to the closing quote are not reported again.
7. **Invalid UTF-8 is reported per line and the other lines are still examined.** Lines are decoded on demand in that case, so a hostile file cannot make the parser pay for a failed decode on every line after the hundredth issue.
8. **Exports beyond the plan's interface:** `DOTENV_RULES` (the rule list as a value; `DotenvRule` is derived from it), `DOTENV_MAX_ISSUES`, `DotenvEntry`, `DotenvEntryError` with `DotenvEntryRule`, `canonicalDotenvEntries`, `escapeDotenvValue`. `loaderWarnings` throws `DotenvEntryError` for entries the writer would refuse, because its rules depend on canonical order.
9. **The corpus has three sets, not one file.** The two small sets hold the line-separator cases. In them every key is warned, so in the main set they would have made the "changed implies warned" check pass for everything.
10. **The difference table is generated, and checked.** `loaders.test.ts` writes it between two markers in the runbook when `MYKEY_WRITE_LOADER_TABLE=1` is set and otherwise fails if the document differs from the loader runs.
11. **`@next/env` results are taken from `parsedEnv`**, the object Next.js copies into `process.env`; the loader script also confirms that `process.env` holds the same values.
12. **No fixture file for `file_too_large`.** A 1 MiB file in the repository proves nothing the in-memory test does not.
13. **Rebased twice onto `session-1`** while Runs 1.6 and 1.7 landed, so the branch can be fast-forwarded. `tests/package.json` and `pnpm-lock.yaml` were re-done on the new base, not merged by hand. The export line sits after `./ids.ts`, away from the lines Run 1.6 added.
14. **Commit trailers** carry the `Co-Authored-By` line and, after it, the `Claude-Session` line the agent harness requires.

No contradiction between the plan's grammar and Document 04 §5 was found.

## Open issues

- **An export can be larger than the import limit.** `LIMITS.environment.maxLiveValueBytes` is 8 MiB, the dotenv import limit is 1 MiB, and escaping can double a value. `serializeDotenv` does not refuse such a file; `parseDotenv` rejects it with `file_too_large`. FR-1.38 holds for every file within the limits. The import and export runs must decide what happens beyond them.
- **The `@next/env` finding is more than a display difference.** With a specific pair of neighbouring values, a canonical export read by Next.js can lose a key or give one key a value taken from another. The warnings name the affected keys. Whether the export screen should do more than warn is a product decision for the export run.
- **A key that already exists in the process environment** is kept by `@next/env`, and by `load_dotenv` unless `override=True`. This does not depend on the file and no warning covers it; the runbook says so. Read in the loaders' source, not tested.
- **The integration test has not run on Linux end to end.** Both loader scripts were run in Linux containers with identical results, and `python -m venv` plus `pip install --require-hashes` worked there. The harness path through Vitest on Linux, and the `actions/setup-python` step, run for the first time in CI.
- **A workstation needs Python 3 with `venv` and `pip`.** On Debian or Ubuntu system Pythons that is the `python3-venv` package. Without it the loader test fails with Python's own message; it does not skip.
- **The neighbour rule may warn for an entry `@next/env` reads correctly** when two backslash-ended values follow each other in a particular way. It never stays silent about a change in the corpus. It was derived from the parsing expression of the pinned loader; a new loader version needs the integration test re-run and the table regenerated.
