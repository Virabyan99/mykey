# D-11 — Owner and agent duties

**Date:** 2026-11-10

**Status:** CONFIRMED by the owner on 2026-11-11

## Decision

The owner buys OVHcloud resources when an agent asks (§5). Agents create and manage everything in **GitHub and Cloudflare** themselves.

## What it changes

Assigns responsibilities.

## Owner inputs recorded here

| Input                                   | Value                                                                                                                                 | Recorded   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Alert channel (first needed in Run 2.6) | Telegram                                                                                                                              | 2026-11-11 |
| Operator VPN client (Run 2.5, P-28)     | WireGuard for Windows; installed on the workstation by the agent, version 1.1.1                                                       | 2026-11-11 |
| Domain (Run 2.5)                        | not yet named                                                                                                                         | —          |
| OVHcloud servers (Run 2.5)              | two OVHcloud US VPS-2 in `os-us-east-va-2`: `40.160.47.48` = `mykey-prod`, `40.160.47.50` = `mykey-staging`; KMS region `us-east-vin` | 2026-11-11 |

The owner asked on 2026-11-11 to be involved only where their permission is needed. Agents therefore do every step they can do themselves and bring the owner only purchases, provider-console steps (D-11), credentials only the owner can create, and Windows permission prompts.

## Amends

The responsibility assignments of Documents 07 and 08. Replaced by Document 10 §4.6 and §5.
