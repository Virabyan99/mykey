# D-24 — Thin CLI over OpenBao Agent

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.8. It confirms D-08 with one measured comparison: OpenBao Agent 2.7.2 in process-supervisor mode, in a Linux container from the pinned image, against the dev stack. Fixture and commands: `tests/fixtures/agent-spike/`. Evidence: `docs/evidence/session-2/run-2.8.md`.

**Verdict:** the thin CLI stands. The Agent fails four of the nine requirements outright (1, 2, 3, 4), and two more only with configuration the product could not enforce on a workstation (5, 8).

## Observations

| #   | Question                                                                                                  | Answer for OpenBao Agent 2.7.2                                                                                                                                                                                                                                                                                                              | How                                                |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Is process-supervisor mode a pre-release feature?                                                         | **Yes**: "OpenBao Agent's Process Supervisor Mode is in public beta." D-01 allows no pre-release component in the product path.                                                                                                                                                                                                             | documented (openbao.org, process-supervisor page)  |
| 2   | Must every secret name be written into the configuration? Can it deliver "all secrets of an environment"? | **Yes, one `env_template` block per name**; there is no form that delivers every secret of a path.                                                                                                                                                                                                                                          | observed (`agent.hcl`, `run.sh`)                   |
| 3   | One of three names does not exist: does the child start?                                                  | **It never starts**, which is right; but the Agent retries for as long as it runs (a warning every second), and when it is stopped it exits with code **0**. A caller cannot tell "nothing ran" from "ran and succeeded". The direct template form `(secret "…").Data.data.value` fails even for an existing name, before the data arrives. | observed (scenarios s2, s3)                        |
| 4   | Does the workstation need a direct network path to OpenBao?                                               | **Yes**: the Agent talks to the OpenBao API (`https://openbao:8200`). The product exposes only its own API on 443.                                                                                                                                                                                                                          | observed (`agent.hcl`)                             |
| 5   | Where does the token sit; can the child read it?                                                          | Not in the child's environment (`BAO_TOKEN` absent), but in the token file, which the child **can read** (same user, same file system).                                                                                                                                                                                                     | observed (`child.sh`: `CHILD-TOKEN-FILE readable`) |
| 6   | With the same raw token, can a retained old version be read?                                              | **Yes**: the machine token read version 1 of a secret whose current version is 2. The product API returns only current values.                                                                                                                                                                                                              | observed (`bao kv get -version=1`, exit 0)         |
| 7   | Exit code and signals                                                                                     | The child's exit code is returned (child 7 → Agent 7); SIGTERM to the Agent reaches the child.                                                                                                                                                                                                                                              | observed (s1, s4)                                  |
| 8   | A value changes while the child runs                                                                      | **The child is restarted**: with the default `restart_on_secret_changes = "always"` it got SIGTERM and was started again a few seconds after the new version (render interval 3 s here, 5 min by default). `"never"` exists.                                                                                                                | observed (s5: two starts, one TERM)                |
| 9   | Platforms with a binary                                                                                   | Release archives for Linux, macOS, Windows, FreeBSD, NetBSD, OpenBSD (amd64 and arm64; more architectures on Linux). Supervisor behaviour on Windows was not observed.                                                                                                                                                                      | documented (GitHub release v2.7.2 assets)          |

## What Run 5.5 hands over (requirements of the thin CLI)

1. Delivers the **complete current set** of an environment without a name list in a configuration file.
2. Starts **nothing** when the set is incomplete or cannot be read, and then exits **non-zero** with a contract error code.
3. Talks only to the product API on 443; no network path to OpenBao.
4. Keeps its credential out of the child: neither in the child's environment nor in a file the child can read by default.
5. Reads current values only; no access to retained versions.
6. Returns the child's exit code and forwards SIGINT and SIGTERM (Windows: the console control events).
7. Never restarts the child on its own.
8. One supported build for Windows, macOS and Linux (the CLI matrix of Session 5).
9. No pre-release dependency.

## Cost if wrong

If the Agent were adopted later, requirements 1–4 would need product-side workarounds (a generated name list, an exit-code wrapper, a network path to OpenBao), which is the thin CLI's work again.
