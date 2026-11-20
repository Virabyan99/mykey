# D-68 — The CLI trusts only what it is given

**Date:** 2026-11-20

**Status:** DECIDED (Run 8.6, review finding R5-2; it reverses the `NODE_EXTRA_CA_CERTS` ruling of D-43). Built in `cli-v0.1.2`, together with R5-1, R5-3 and R5-4. Evidence: `docs/evidence/session-8/review-5-cli.md` and `run-8.6.md`; `tests/unit/cli/guard.test.ts`, `tests/unit/cli/config.test.ts`, `tests/cli/run.test.ts` ("an http URL, an untrusted certificate, a setting that changes trust and another API major each start nothing").

## Context

D-43 refused the runtime settings that switch off verification or load code, and allowed `NODE_EXTRA_CA_CERTS` because "it adds trust and removes none". Reviewer 5 showed that added trust is exactly what interception needs. A laptop or CI image often sets `NODE_EXTRA_CA_CERTS` machine-wide for a TLS-inspecting proxy. The CLI would then accept that proxy's certificate for the API's name, and the proxy would see the machine token and every value of `resolve`, while the CLI exits 0. `OPENSSL_CONF` was not refused either, although Node reads it at start and it can load OpenSSL modules into the CLI.

## Decision

1. **Refused (exit 78, before anything else):**
   - the variables `NODE_EXTRA_CA_CERTS`, `OPENSSL_CONF`, `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE` and `SSL_CERT_DIR`;
   - the Node flags `--use-openssl-ca`, `--use-system-ca`, `--openssl-config` and `--openssl-shared-config`.

   A machine-wide setting is never meant for this CLI.

2. **A certificate authority for this CLI alone** is named by `SECRETS_CA_FILE`, a PEM file that is added to Node's public roots and never replaces them. Nothing else of the system reaches the CLI's trust. Like every `SECRETS_*` variable, it never reaches a child.
3. **Where it applies.** The hosts serve publicly trusted certificates, so a consumer never needs `SECRETS_CA_FILE`. The CLI's own tests use it for their local server.

## Consequences

- A consumer who must go through an inspecting proxy has to name that proxy's authority in `SECRETS_CA_FILE` on purpose. That is a visible, product-specific choice, not a side effect of the machine's settings.
- D-43's boundary stands: a launcher that is already hostile cannot be made safe by JavaScript.
- The CLI's version is `0.1.2`. Its proofs are `cli-matrix`, `cli.staging` and `test:consumers` (P-145), and the consumer runbooks name it from the freeze on.
