# Session 6 — requests to the owner

Written at the session start (16 Nov 2026). No value appears in this file. Four things are asked; each says when it is needed.

## 1. Lend the production server to the restore drill (instead of OWN-5; nothing is bought)

**Needed:** a yes before Run 6.8 (Day 10 morning, 19 Nov 2026), then two reinstalls.

Doc 10 asks for a temporary clean server for the drill (OWN-5). Production holds nothing today (no OpenBao, no owner, no data, no open gate), is the same VPS plan in the same region as staging, and `docs/runbooks/network.md` already names "reinstall the VPS and bootstrap again" as its recovery path. The plan (P-125) therefore borrows it:

- **Reinstall 1, before Run 6.8:** OVHcloud panel → the production VPS → Reinstall, Ubuntu 24.04, SSH key `mykey-ops`, as `network.md` describes. Please check first that the panel shows no charge for a reinstall.
- **Reinstall 2, at the gate (Run 6.11):** the same again. It removes every byte of staging's data and of the drill's credentials; the agent then installs production fresh from the session's release, closed, as it is today.

If the answer is no, or the panel shows a charge, say so: the agent then asks for the temporary server of Doc 10 instead, and nothing else of the plan changes.

## 2. One KMS certificate for the drill host (10 minutes in the OVH console)

**Needed:** during Run 6.8, when the agent sends the CSR.

One certificate under **staging's** KMS domain (the restore needs staging's seal key), issued from the CSR the agent sends (as in D-23). It is revoked at the gate.

## 3. OWN-4: an offline copy of the backup custody files

**Needed:** after Run 6.5; the agent says when the two files exist.

Copy `~/.mykey/custody/staging/backup/` (two files: the backup password and the manifest signing key) to your offline medium, then answer "copied".

## 4. Production at the gate

After reinstall 2, production is installed fresh from this session's release with migrations up to `0018`, closed and without a gate file — the state it has today, on the new release. This is part of giving the server back and needs no separate yes. (Without the loan — a bought server — it is the usual yes or no for a production deploy.)

## What will arrive in Telegram without any action from you

- **Day 9 (18 Nov 2026) and Day 10 (19 Nov 2026):** test alerts and drilled alerts from staging (`MyKey staging: …`) while every alert of FR-1.63 is proven to arrive. Each drill names its alerts in its run note; every alert opened by a drill is closed by it.
- **Day 10:** alerts for the host `drill` during the restore drill.
