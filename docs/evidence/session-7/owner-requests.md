# Session 7 — requests to the owner

Written at the session start (19 Nov 2026). No value appears in this file. Two one-line answers were asked.

## 1. Scope valve 1: the analytics are tables, no charts

**Answered: yes** (the owner, 19 Nov 2026, with the word to start the session).

Doc 10 §8.2 item 1. The workspace's summary is three tables, each with its source, its window and its observation time (plan P-142, decision record D-62 in Run 7.8). FR-1.94 keeps its minimum.

## 2. OWN-4: an offline copy of the backup custody files

**Answered: copied** (the owner, 20 Nov 2026). The two files of `~/.mykey/custody/staging/backup/` exist since 17 Nov 2026 16:45 UTC, and the owner keeps a second copy in a password manager. That copy survives the loss of the workstation; it is not a copy on paper or on a disconnected device.

## What comes at the end

The owner is asked to read `docs/evidence/session-7/report.md` and to say "merge". Nothing else is needed during the session: no purchase, no console step, and production is not touched.

## After the gate (20 Nov 2026)

- **"merge"**: said; PR #19 is merged.
- **`host.ts prod push`**: the owner gave the word. Production's host files now hold the fixed `bao-audit-rotate.sh` (read back on the host: the new signal line is there, and no `docker kill` is left). Nothing was deployed and no container was restarted: the gate is closed as before, and production still has no OpenBao.
