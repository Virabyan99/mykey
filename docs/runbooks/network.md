# Network runbook

How the two MyKey servers are reached, what their firewall allows, and what to do when access is lost. Decision record: `docs/decisions/D-21-host-network-and-egress.md`.

## Hosts

| Role      | Host name                   | Public IPv4    | VPN address | OVHcloud name             |
| --------- | --------------------------- | -------------- | ----------- | ------------------------- |
| `prod`    | `mykey.nomikey.com`         | `40.160.47.48` | `10.77.1.1` | `vps-1174cf5d.vps.ovh.us` |
| `staging` | `mykey-staging.nomikey.com` | `40.160.47.50` | `10.77.2.1` | `vps-4bc44923.vps.ovh.us` |

Both are OVHcloud US VPS (plan VPS-2, Ubuntu 24.04, OpenStack region `os-us-east-va-2`). The workstation reads them from `~/.mykey/hosts.json`.

SSH host keys (ED25519), pinned in `~/.mykey/ssh/known_hosts`; every connection uses `StrictHostKeyChecking=yes`:

| Host      | Fingerprint                                          |
| --------- | ---------------------------------------------------- |
| `prod`    | `SHA256:2vXFVzU8QARkKIyHzkaa4H8RgGBvxh6cpavkRRrkMHM` |
| `staging` | `SHA256:ZYgCPnnWhp/N2bzPtm/wAuybx88YiVs//CZPDgdWSkU` |

A changed host key is never accepted by hand. It means the server was reinstalled or something is in the path: stop and find out which.

## How the operator gets in

SSH listens on the VPN address only. Port 22 on the public address does not answer.

- **VPN:** WireGuard. The workstation tunnel is `mykey-ops` (file `~/.mykey/wireguard/mykey-ops.conf`, Windows service `WireGuardTunnel$mykey-ops`). The workstation is `10.77.1.10` towards production and `10.77.2.10` towards staging; each server listens on UDP 51820 and knows one peer.
- **SSH:** user `ubuntu`, key `~/.mykey/ssh/mykey_ops_ed25519`, no passwords, no root login, local port forwarding only.
- **Tool:** `node scripts/host.ts <staging|prod> <command>` uses the VPN address by default. `--public` exists for the first contact with a new server only.

```sh
node scripts/host.ts staging status     # one JSON object: boot id, firewall sets, SSH listeners, pending reverts
```

If the tunnel is down on the workstation, start the service in an elevated prompt: `sc start WireGuardTunnel$mykey-ops`.

## Changing the firewall or SSH

Every network change is applied with a timed automatic revert.

```sh
node scripts/host.ts staging push              # copy infra/hosts/** to the server, read owner, mode and content back
node scripts/host.ts staging apply firewall    # arms a revert in 300 s, then loads the rules
node scripts/host.ts staging confirm           # from a new connection: cancels the revert
```

- `apply` first starts a systemd timer `mykey-revert-<name>` on the server, then applies. The timer does not depend on the SSH connection.
- `confirm` only works from a connection that was opened after the apply, so a change that cuts access cannot be confirmed by accident.
- Not confirmed within 300 seconds: the server undoes the change by itself. For `firewall` that removes the table `inet mykey`; for `ssh` that makes SSH listen publicly again and reopens port 22.
- Staging first. Production only after staging is confirmed and `status` shows `pendingRevert: []`.
- Never reboot a server while a revert is pending: the timer does not survive a reboot.

Measured on staging on 2026-11-11: a rule that blocked SSH on the VPN was applied and not confirmed; SSH worked again 305 seconds after the apply.

## What the firewall allows

File `infra/hosts/firewall/mykey.nft`, table `inet mykey`, three chains with `policy drop` that run before Docker's chains.

- **In:** WireGuard (UDP 51820), SSH from the VPN interface, the DHCP answer for the public address, the ICMP needed for path MTU and neighbour discovery. Nothing new from a container network to the host. TCP 443 reaches the `edge` container.
- **Out, from the host:** DNS to the resolver the server was given (`213.186.33.99`), NTP to two fixed addresses (`162.159.200.1`, `162.159.200.123`), the cloud metadata service, and TCP to the address sets below.
- **Out, from containers:** only `edge` to the ACME set and `openbao` to the KMS set. Containers on internal bridges reach nothing outside their bridge. All container IPv6 is dropped.

Address sets are filled from names in `infra/hosts/firewall/egress-names.conf` every 5 minutes and once at boot before Docker starts; each address stays for one hour.

| Set        | Used for                                        | Port    |
| ---------- | ----------------------------------------------- | ------- |
| `acme`     | Let's Encrypt                                   | 443     |
| `kms`      | OVHcloud KMS (`us-east-vin.okms.ovh.us`)        | 5696    |
| `r2`       | Cloudflare R2 backups                           | 443     |
| `probe`    | the external probe                              | 443     |
| `apt`      | Ubuntu package mirrors                          | 80, 443 |
| `registry` | Docker Hub — empty outside a maintenance window | 443     |

### Container networks

Docker Compose project `mykey` (`infra/compose/host.compose.yml`). Every bridge has a fixed name, so the firewall can name it; IPv6 is off on all of them.

| Bridge    | Network      | Subnet         | Members (address)                                | Leads out                 |
| --------- | ------------ | -------------- | ------------------------------------------------ | ------------------------- |
| `mk-pub`  | `mykey_pub`  | `10.78.0.0/28` | `edge` (`.2`)                                    | yes: ACME set on 443, DNS |
| `mk-edge` | `mykey_edge` | `10.78.1.0/28` | `edge` (`.2`), `api` (`.3`)                      | no (`internal`)           |
| `mk-db`   | `mykey_db`   | `10.78.2.0/28` | `postgres` (`.2`), `api` (`.3`); operator tunnel | no (`internal`)           |
| `mk-bao`  | from Run 2.7 | set in Run 2.7 | `openbao` (`.2`), `api`, `provisioner`           | no (`internal`)           |
| `mk-kms`  | from Run 2.7 | set in Run 2.7 | `openbao`                                        | yes: KMS set on 5696      |

The public port 443 of the host is published to `edge:8443` and is the only inbound port besides WireGuard. Containers resolve names through Docker's resolver (`127.0.0.11`). Observed with Docker 29.1.3: on `mk-pub` public names resolve (the forward chain lets `mk-pub` reach the resolver on port 53); on the internal bridges they do not, and a query straight to another resolver fails everywhere.

### Maintenance window and blocks

Docker Hub is reachable only during a maintenance window. While it is open the `registry` set follows the resolver every 2 seconds (Docker Hub's CDN changes addresses within a minute); it is emptied when the window closes, also when the command fails.

```sh
# Git Bash rewrites /etc/... arguments: switch that off for host.ts.
export MSYS_NO_PATHCONV=1
node scripts/host.ts staging maint 10 -- docker compose --env-file /etc/mykey/host.env \
  -f /opt/mykey/compose/host.compose.yml -p mykey pull --quiet postgres edge
```

To cut one purpose off for a drill, on the server: `sudo /opt/mykey/hosts/firewall/mykey-egress.sh block <acme|kms|r2|probe|apt|registry> <seconds>`. The kernel ends the block by itself (the addresses carry a timeout); a timer refills the set two seconds later. To end a block early, run `sudo /opt/mykey/hosts/firewall/mykey-egress.sh apply` (reloads the table, which drops every block). `mykey-egress.sh counts` prints the number of addresses per set.

## Deploying the services

```sh
docker build --platform linux/amd64 -f apps/api/Dockerfile -t mykey-api .
docker save mykey-api -o C:/Users/<you>/mykey-tmp/mykey-api.tar      # outside OneDrive
node scripts/host.ts staging image api C:/Users/<you>/mykey-tmp/mykey-api.tar
node scripts/host.ts staging up          # creates missing host secrets, then compose up -d
node scripts/host.ts staging db-init     # roles and migrations through an SSH tunnel
```

- **`image`** sends the archive in 2 MiB parts over eight SSH connections and loads it only when the checksum of the joined parts matches. The upload direction from the workstation loses packets on the way to the US hosts (6 to 23 % measured), which holds a single connection near 40 kB/s; eight connections moved 66 MB in 61 s.
- **Upstream images** (`postgres`, `traefik`) are pulled on the host by digest inside a maintenance window (above), never copied with `docker save`.
- **Secrets on a host:** only the PostgreSQL superuser password (`/etc/mykey/secrets/postgres/`, owner 999) and the `api_runtime` password (`/etc/mykey/secrets/api/`, owner 1000). The other four role passwords live on the workstation under `~/.mykey/secrets/hosts/<host>/<role>`.

### Public certificate

A new host starts on the Let's Encrypt **staging** directory. Switch only after the staging certificate was issued:

```sh
node scripts/host.ts staging acme production   # records the directory, removes edge, the finished pki-init and the ACME volume
node scripts/host.ts staging up                # the edge asks the new directory once
```

Never loop on the production directory (rate limits). If issuance fails there, go back with `acme staging`, find the cause, then switch once more. Without the volume removal Traefik keeps serving the old certificate after a directory change.

## Checking a host from outside

```sh
pnpm run test:staging   # boundary and transport, staging and production (about 20 minutes; reboots staging once)
```

The scan uses the pinned nmap image (`infra/dependencies.lock.json`, `images.nmap`) against the public address. The workstation's own network answers TCP 53 for every destination; the test detects such ports with the reserved address `192.0.2.1` and checks them on the host instead. Scan files: `docs/evidence/session-2/host-scan-<host>.txt`.

## After a reboot

Nothing needs to be typed. Measured on 2026-11-11: SSH over the VPN answered 27 seconds (staging) and 59 seconds (production) after `systemctl reboot`, with the firewall loaded, the sets filled and the clock synchronised.

## Break-glass: no access over the VPN

Work through this in order.

1. Check the workstation: is the `mykey-ops` tunnel running, and does `ping 10.77.2.1` answer?
2. Wait 5 minutes. A change that was applied and not confirmed reverts by itself.
3. **KVM console, by the owner:** Control Panel → the VPS → KVM. Log in as `ubuntu` with the password the owner set at the first login (password login is switched off for SSH only). Undo the last change as in step 4 and restart `ssh.socket`.
4. **Rescue mode, by the owner:** Control Panel → the VPS → Boot → "Reboot in rescue mode". OVHcloud e-mails a temporary root password. Mount the server's disk and undo the last change:
   - remove `/etc/systemd/system/ssh.socket.d/10-mykey.conf` to make SSH listen publicly again;
   - move `/etc/nftables.d/mykey.nft` away to boot without the firewall.

   Then reboot normally from the Control Panel and repair over SSH.

5. Last resort: reinstall the VPS with the `mykey-ops` key and run `node scripts/host.ts <host> bootstrap` again. Production holds no data before Session 6; after that, restore from backup (`docs/runbooks/restore.md`, written in Session 6).

The agent never asks for the OVHcloud password. Steps 3 to 5 are the owner's.
