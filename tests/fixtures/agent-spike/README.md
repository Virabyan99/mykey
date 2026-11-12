# OpenBao Agent spike (Run 2.8)

One measured comparison for D-24: OpenBao Agent 2.7.2 in process-supervisor mode (`env_template` + `exec`) against the requirements of the thin CLI (D-08).

```sh
node tests/fixtures/agent-spike/drive.ts
```

`drive.ts` starts the dev stack `mykey-dev` if needed (and leaves it running; `pnpm run stack:down` removes it), creates one synthetic organization with `A_ONE` (two versions) and `A_TWO`, issues a machine token for the environment with the root token, and runs `run.sh` in a container from the pinned OpenBao image on the stack's network. The tokens travel in a temporary directory outside the repository and are removed afterwards.

- `agent.hcl` — the Agent configuration; `run.sh` fills in one `env_template` block per secret name and the child's mode.
- `child.sh` — prints the names of its environment variables and, per expected name, whether it is unset, empty or set. Never a value.
- `run.sh` — the scenarios: two names and a child exiting 7; a third name that does not exist (two template forms); SIGTERM to the Agent; a value changed while the child runs; an old version read with the raw machine token.

The observations are in `docs/decisions/D-24-thin-cli-over-openbao-agent.md`.
