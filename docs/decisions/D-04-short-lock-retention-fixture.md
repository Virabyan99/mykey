# D-04 — Short-lock retention fixture at Gate R

**Date:** 2026-11-10

**Status:** CONFIRMED by the owner on 2026-11-11 (explicit yes)

## Decision

At Gate R, AC-1.36 and AC-1.44 are proven with a **short-lock retention fixture** started on Day 1 (same bucket-lock mechanism, lock of a few days) that shows denied deletes, lock expiry, per-object delete errors, clean-up and restore of the oldest eligible pair. Production uses the real 30-day rule, verified by read-back. Real 30-day ageing is checked once as watch item **W-1**.

## What it changes

Formal amendment of the "actual 30-day ageing before release" rule.

## Amends

AC-1.36, AC-1.44, Document 06 §13.3 (the "actual 30-day ageing before release" rule). Real ageing moves to watch item W-1 (Document 10 §11).
