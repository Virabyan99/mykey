# Owner kick-off message (OWN-1; announces OWN-2 and OWN-3)

Sent 2026-11-10 in the Session 1 execution chat. Work continued without waiting.

## 1. Please confirm the eleven decisions

D-01 … D-11 are recorded in `docs/decisions/` as "ASSUMED — awaiting owner". Two of them move calendar-bound checks out of the 14 days and need your explicit yes:

- **D-04 — short-lock retention fixture.** At Gate R the 30-day backup-retention rule is proven with a fixture locked for a few days (started today); production still gets the real 30-day lock, and real 30-day ageing is checked once afterwards as watch item W-1.
- **D-05 — stage exit on Day 14.** Gate F is decided on Day 14 (23 November 2026) with the real-use days available by then; the 28-day observation continues passively as watch item W-2.

## 2. Five questions

1. Which domain should the production and staging hostnames use, and is that domain managed in Cloudflare? (No default; first needed in Run 2.5.)
2. Where should alerts go — email, Telegram, something else? (No default; first needed in Run 2.6.)
3. Do records P-01 / P-02 / P-03 exist anywhere? (Default: no.)
4. Repository name? (Default: `mykey`, private.)
5. Is R2 enabled on your Cloudflare account? It has to be switched on once in the dashboard, with billing, before any bucket or token can be created. Needed **today** for Run 1.9.

## 3. OWN-2 — two servers, needed by the start of Run 2.5 (Day 2, midday at the latest)

Two OVHcloud Public Cloud instances in **one region where OVHcloud KMS is also offered** (check the KMS order page for that region before buying):

- names `mykey-prod` and `mykey-staging`
- flavour **C3-8** (4 vCPU / 8 GB / 100 GB NVMe) or the nearest with at least 4 vCPU, 8 GB RAM, 80 GB SSD, x64
- Ubuntu 24.04 LTS, hourly billing
- instance SSH key = this public key:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN0foBL/tE7dqXxmz0BwbR9PVvVLPYZDHEduGly8qBal mykey-ops
```

Reply with the two IPv4 addresses and the region. Run 1.3 confirms the size today; you will be told at once if it changes.

## 4. OWN-3 — OVHcloud KMS, needed by Run 2.7 (Day 3)

Activate OVHcloud KMS in that same region. Nothing to create yet beyond activating the service; the exact steps (seal key, one disposable key, KMIP access certificate placed directly on the staging host) come with the Session 2 plan.

## Defaults if there is no reply by the end of Run 1.2

Repository `mykey`; P-records absent; all decisions assumed. The domain and the alert destination have no default.
