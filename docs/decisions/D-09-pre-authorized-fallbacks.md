# D-09 — Pre-authorized technical fallbacks

**Date:** 2026-11-10

**Status:** CONFIRMED by the owner on 2026-11-11

## Decision

The fallbacks in §8.1 are **pre-authorized**. If the first-choice design fails its proof inside its run, the agent switches to the listed fallback and records it, without waiting for approval.

## What it changes

Removes stop-and-wait points.

## Amends

The stop-and-wait approval points of Documents 06 §17 and 08 for the areas listed in Document 10 §8.1.
