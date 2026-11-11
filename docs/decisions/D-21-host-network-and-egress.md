# D-21 — Host network and egress model

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.5, on the two OVHcloud US VPS (Ubuntu 24.04.4, Docker 29.1.3, nftables 1.0.9). Evidence: `tests/staging/boundary.staging.test.ts`, `tests/staging/transport.staging.test.ts`, `docs/evidence/session-2/host-scan-*.txt`, `docs/evidence/session-2/run-2.5.md`. Runbook: `docs/runbooks/network.md`.

## Decision

The planner decisions P-28 to P-32 hold as written, with the changes listed under "Deviations".

- **P-28 — VPN.** WireGuard for Windows on the workstation, one tunnel `mykey-ops` with two peers: production `10.77.1.1`, staging `10.77.2.1`; the workstation is `10.77.1.10` and `10.77.2.10`; UDP 51820. The hosts are not peers of each other. Each peer's `AllowedIPs` is the host's VPN address only (`/32`), so traffic to a public address never enters the tunnel. SSH listens on the VPN address only, key-only, no root login.
- **P-29 — configuration.** `scripts/host.ts` pushes `infra/hosts/**` and `infra/compose/host*`, reads owner, mode and content back, and runs idempotent shell scripts. Every network change runs under `apply-with-revert.sh` with a 300 s systemd timer; `confirm` works only from a connection opened after the apply.
- **P-30 — firewall.** One table `inet mykey`, chains `input`, `forward`, `output` at `priority filter - 5` with `policy drop`, loaded through an include-only `/etc/nftables.conf` (never `flush ruleset`); Docker's own chains are not edited. Compose bridges have fixed names (`mk-pub`, `mk-edge`, `mk-db`; `mk-bao` and `mk-kms` from Run 2.7). Outbound traffic is allowed per purpose to address sets filled from the committed names in `infra/hosts/firewall/egress-names.conf` by a timer (every 5 minutes, once at boot before Docker, one hour per address):

  | Set        | From                          | Port    |
  | ---------- | ----------------------------- | ------- |
  | `dns`      | host; `mk-pub`, `mk-kms`      | 53      |
  | `ntp`      | host                          | 123     |
  | `acme`     | `mk-pub` (the edge)           | 443     |
  | `kms`      | `mk-kms` (OpenBao)            | 5696    |
  | `r2`       | host                          | 443     |
  | `probe`    | host                          | 443     |
  | `apt`      | host                          | 80, 443 |
  | `registry` | host, maintenance window only | 443     |

  `api`, `provisioner` and `postgres` sit on internal bridges only and have no route out. A `blocked` set with kernel timeouts is checked before `established`, so a drill also cuts open connections and ends by itself (R16).

- **P-31 — images.** First-party images are built on the workstation and moved with `docker save` → SSH → `docker load`, referenced by image ID in `/etc/mykey/host.env`. Upstream images are pulled on the host by digest during a maintenance window that opens `registry` egress.
- **P-32 — names and certificates.** `mykey.nomikey.com` (production), `mykey-staging.nomikey.com` (staging), `mykey-probe.nomikey.com` (probe, Run 2.6). Let's Encrypt by TLS-ALPN-01, registered without an e-mail address, staging directory first; HSTS `max-age=63072000` without `includeSubDomains`; TLS 1.2 minimum, strict SNI.

**Fixed addresses.** The resolver is the one the VPS was given by DHCP (`213.186.33.99`). NTP uses two fixed Cloudflare anycast addresses (`162.159.200.1`, `162.159.200.123`) through chrony (R15), because the VPS was given no NTP server. The host may also reach the OpenStack metadata service (`169.254.169.254`, TCP 80) that cloud-init asks at boot (R20). No container ever gets a general port 53 or 443.

## Observed DNS behaviour (Docker 29.1.3)

Containers use Docker's embedded resolver (`nameserver 127.0.0.11`). On `mk-pub` public names resolve; the forward chain lets `mk-pub` reach the resolver of the `dns` set on port 53. On the internal bridges (`mk-edge`, `mk-db`) public names do not resolve. A query straight to another resolver (`8.8.8.8`, UDP 53) fails from every bridge. This is the minimum ACME needs; KMIP from `mk-kms` gets the same rule in Run 2.7.

## Deviations from the plan

- **Image upload in parts (R26).** The upload direction from the workstation to the US hosts loses 6 to 23 % of packets, which holds one SSH stream near 40 kB/s. `host.ts image` sends 2 MiB parts over eight connections and loads them only when the checksum of the joined parts matches.
- **Maintenance window follows the resolver (R27).** Docker Hub served layers from `production.cloudfront.docker.com`, whose addresses change within a minute; the name was added and the `registry` set is refreshed every 2 seconds while the window is open.
- **ACME switch as a command (R28).** `host.ts <host> acme <staging|production>` records the directory and removes the edge, the finished `pki-init` container and the ACME volume, because Traefik keeps serving a certificate of the old directory otherwise.
- **The outside scan cannot judge TCP 53.** The workstation's network answers TCP 53 for every destination. The scan detects such ports with the reserved address `192.0.2.1` and the test checks them on the host instead (no listener outside loopback). A scan from a neutral vantage point (the probe Worker of Run 2.6) can close this gap.

## Open weakness for the Session 8 review

For names served from shared provider addresses (Cloudflare R2, Let's Encrypt, the Worker, Docker Hub's CDNs) the egress rule is an **address** allowlist, not a **name** allowlist: anything else served from the same addresses is reachable on the allowed port. An SNI-filtering proxy is the stricter design; Session 8 demands or waives it. Also open: the hosts have a global IPv6 address on `ens3`; the table is `inet` and treats IPv6 like IPv4, Docker publishes 443 on IPv4 only, but IPv6 was not scanned from outside in this run.

## Cost if wrong

A missing name in `egress-names.conf` stops one purpose until it is added; the timer and the maintenance window make the effect visible at once. A wrong rule is caught by the timed revert or, at the latest, by the break-glass steps of the runbook.
