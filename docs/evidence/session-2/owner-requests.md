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

**2026-11-11**

- D-01 … D-11 confirmed, with an explicit yes for D-04 and D-05.
- Alerts go to Telegram. The bot token file is still to come.
- The owner wants the least possible involvement: agents do everything they can, the owner does only what needs their permission. WireGuard for Windows was therefore installed by the agent (the owner approved the Windows permission prompt); item 5 shrinks to one more permission prompt when the tunnel file exists.
- Correction to item 3: the token also needs **Zone → Workers Routes: Edit** for the chosen zone, so that the probe can be served at `mykey-probe.<domain>`.
- Still open: the domain, the two servers (item 2), the Cloudflare token (item 3), the Telegram bot token (item 4).

**2026-11-11, later**

- The owner bought two OVHcloud **US** VPS of plan VPS-2 (4 vCores, 8 GB, 75 GB NVMe) instead of Public Cloud C3-8 instances. Accepted: Doc 10 asks for "two OVHcloud Linux servers"; the notes about "Basic IP" and the `default` security group in item 2 do not apply to VPS.
- Addresses: `40.160.47.48` (assigned by the agent as `mykey-prod`) and `40.160.47.50` (`mykey-staging`). Both are in OpenStack region `os-us-east-va-2` (US East, Virginia), so the KMS region is `us-east-vin` and the KMIP endpoint `us-east-vin.okms.ovh.us:5696`, not the `.ovh.net` name the plan assumed.
- The `mykey-ops` key was not installed at order: key login as `ubuntu` and as `root` is refused on both. The owner was asked to store the key in the account and reinstall both servers with Ubuntu 24.04 and that key.
- Still open: the reinstall, the domain, the Cloudflare token (item 3), the Telegram bot token (item 4).

**2026-11-11, evening**

- Both servers were reinstalled with Ubuntu 24.04 and the `mykey-ops` key; the owner changed the forced initial password on each. Key login and passwordless `sudo` verified by the agent, which then switched SSH password login off on both (`/etc/ssh/sshd_config.d/05-mykey-early.conf`).
- Domain: `nomikey.com`, registered at NameSilo. The owner allowed the agent to use the session's Cloudflare connection; the agent created the zone (Free plan) and the DNS-only records `mykey.nomikey.com` → `40.160.47.48` and `mykey-staging.nomikey.com` → `40.160.47.50`; the owner set the Cloudflare nameservers at NameSilo. A registrar transfer to Cloudflare is the owner's own later step and is not needed by MyKey.
- Still open: the Cloudflare token (item 3, zone permissions scoped to `nomikey.com`), the Telegram bot token (item 4), one Windows permission prompt for the tunnel, the KMS steps of Run 2.7.

**2026-11-11, night**

- The owner saved the Cloudflare session token and the Telegram bot token under `~/.mykey/secrets/`; both verified by status code only (Cloudflare: token active, zone `nomikey.com` visible; Telegram: the bot answers). The owner sent a message to the bot, so its chat id is recorded. Items 3 and 4 are closed.
- The token keeps account-wide permissions: the owner chose not to narrow it ("I dont want to narrow it, lets leave it like that"). Agents still touch only `nomikey.com` and the `mykey-*` resources.
- The tunnel was installed with one Windows permission prompt; item 5 is closed. Both servers are locked down (SSH on the VPN only, firewall loaded) and serve `/health` over Let's Encrypt certificates.
- Method: on the owner's word the rest of Session 2 is executed inline, as in Session 1, with one fresh review at the gate (Run 2.10) instead of a reviewer after every unit. The executing model changed from Claude Fable 5.2 to Claude Opus 5.5 during Run 2.5.
- Still open: the KMS steps of Run 2.7 (item 6, OWN-3).
