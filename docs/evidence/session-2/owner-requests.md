# Owner requests for Session 2

Sent 2026-11-11 in the Session 2 execution chat. The local-proof runs (2.1–2.4, 2.8) continue without waiting; the host runs (2.5–2.7, 2.9) start when items 1–4 have arrived.

## 1. Still open from the kick-off (OWN-1)

- Confirm decisions D-01 … D-11. D-04 (short-lock retention fixture) and D-05 (stage exit on Day 14) need an explicit yes.
- Which domain should the host names use, and is its DNS zone on Cloudflare? The names will be `mykey.<domain>`, `mykey-staging.<domain>` and `mykey-probe.<domain>`.
- Where should alerts go: Telegram, a webhook URL, or e-mail (e-mail only if the zone is on Cloudflare)?

## 2. OWN-2 — two servers (needed for Run 2.5)

Two OVHcloud Public Cloud instances:

- names `mykey-prod` and `mykey-staging`
- model **C3-8** (4 vCPU, 8 GB, 100 GB NVMe); B3-16 if C3-8 is not offered
- Ubuntu 24.04 LTS, hourly billing
- one region that has both Compute and KMS — Gravelines (`GRA`, KMS region `eu-west-gra`) and Strasbourg (`SBG`, `eu-west-sbg`) do
- SSH key: the `mykey-ops` public key from `docs/evidence/session-1/owner-kickoff.md`
- in the network step choose **public connectivity: "Basic IP"**. It is off by default, and without it the instance has no public address.
- do not edit the `default` security group

Before buying, copy the private key `~/.mykey/ssh/mykey_ops_ed25519` into your password manager (custody list, row 1).

Reply with both IPv4 addresses and the region.

## 3. A Cloudflare API token for this session

Create it in the dashboard and save it yourself to `~/.mykey/secrets/cloudflare/session-2-token` (never paste it into chat):

- Account → Workers Scripts: Edit
- Account → D1: Edit
- Zone → DNS: Edit, for the chosen zone only (leave this out when the domain is not on Cloudflare; you will then be asked to create two A records yourself)

## 4. The alert channel

- Telegram: create a bot with @BotFather, send it any message from the account that should receive alerts, and save the bot token to `~/.mykey/secrets/alerts/telegram-bot-token`.
- Webhook: save the URL to `~/.mykey/secrets/alerts/webhook-url`.

## 5. Announced now, done during Run 2.5 — VPN

Install WireGuard for Windows:

```text
winget install --id WireGuard.WireGuard
```

When the agent says the tunnel file exists, run once in an elevated prompt:

```text
wireguard /installtunnelservice "%USERPROFILE%\.mykey\wireguard\mykey-ops.conf"
```

## 6. Announced now, done before Run 2.7 — OVHcloud KMS (OWN-3)

About twenty minutes in the OVHcloud Control Panel, in two sittings: order two KMS domains, create two IAM users and two policies, and issue access certificates from signing requests the agent prepares. The exact clicks come with Run 2.7 Step 1 of `docs/plans/session-2-plan.md`. No private key and no password passes through chat.

## Replies

_None yet._
