# D-63 — Fix first, freeze once; and what `PASS` means at Gate R

**Date:** 2026-11-21

**Status:** DECIDED (plan P-143, P-144, P-145). Built in Runs 8.1 Task B and 8.7. Evidence:

- `scripts/release-manifest.ts` and `tests/unit/registry/release-manifest.test.ts`;
- `docs/evidence/session-8/proof-map.json`, `results.json`, `manifest.md` and `candidate.json`;
- `docs/evidence/session-8/run-8.7.md`.

## Context

Doc 10's Run 8.6 says that a change makes a new candidate and repeats the affected proofs. Changes were certain at the start of Session 8: the carried findings, three gaps in production's path, and whatever the six reviews would find. Freezing first would have built, deployed and proven everything twice. Doc 04 §12 and FR-1.101 ask that each release scenario be proven on the integrated product. Until now the registry had only `SPIKE_PASS`, and no rule said what makes an item `PASS`.

## Decision

- **The order (P-143).** First the known changes (Run 8.0), the attacks, the sweep and the reviews (8.2, 8.4 Task A, 8.5), and the fixes (8.6). Then one freeze (Run 8.1 Task B). Then the owner's hour (8.8), and the one pass on the candidate (8.3, 8.4 Task B, 8.7).
- **What may change after the freeze (P-145).**
  - Documents, tests and evidence scripts change nothing of the candidate. That includes the root `.md` files (ruling of Run 8.7).
  - Host files and the operator tool are written into `candidate.json` as `tooling`.
  - A change to the product's source makes one new candidate. That happened once: `host-v0.8.1`, for the page's texts that the claims walk found false (FR-1.102).
- **What `PASS` means (P-144).**
  - An item is `PASS` when `proof-map.json` names the files that prove it, and each file has a green result of its kind:
    - `ci` at a commit that differs from the candidate's only in what P-145 allows;
    - `staging` on the candidate's host release;
    - `cli` on the candidate's CLI release;
    - `cloud`, `consumers`, `review` or `owner`.
  - A proof that needs a calendar or a clean server is `earlier`. It keeps its run's evidence, and the map says what changed since and which files on the candidate cover the change.
  - An item that no file proves is written `NOT PROVEN` with the reason, never `PASS`.
  - An FR is `PASS` when every release scenario of Doc 04 §12 that names it is `PASS`.
  - The Gate F items (AC-1.53, 1.54, 1.58, 1.59) and FR-1.98, 1.99, 1.100 are `NOT YET DUE`.
- **The tool refuses; it does not argue.** `release-manifest.ts` has no `--force`. A missing entry, a missing file, a red or absent result, or a ci commit with a product change is a refusal, named by id.

## Consequences

- The session built two host releases, `host-v0.8.0` and `host-v0.8.1`, not one per fix. Group A was green on `v0.8.0` before the page texts changed, and was run again on `v0.8.1`.
- A staging file that fails for a reason of its own makes every id that names it unproven. So the credential drill, red on the candidate, was given a file of its own (Run 8.7). The journey it shared a file with then proves its ids alone.
- Gate R lists every `earlier` and every `NOT PROVEN` item above the signature line.
