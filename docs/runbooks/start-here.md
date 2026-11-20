# Start here — the owner's first run

One page in the order the owner meets the service, from a reset link to an application that starts with its secrets and no `.env` file. Each step names the screen or the runbook that holds the detail. Use synthetic values only until Gate R is signed.

On staging the address is `https://mykey-staging.nomikey.com`. On production the first account is made by the operator's bootstrap (`operator-accounts.md`, "Bootstrap of the owner"); everything after step 1 is the same.

## 1. The link

The operator runs `ops reset-account` (`operator-accounts.md`, "Reset of a lost password or second factor") and gives you the **path** of a file under `~/.mykey/out/`. The link is in that file, not on the screen. Open the file yourself and paste the link into the browser.

- The link works once, for 15 minutes. If it has expired, ask for a new one: it replaces the old one.
- After pasting, the page removes the link from the address bar.
- Shred the file once the reset is done (`operator-accounts.md`, "Shredding output files").

## 2. Password, authenticator and recovery codes

On the reset page:

1. Choose a new password.
2. Enrol an authenticator app. The setup key is shown as text and as an `otpauth://` address; there is no QR code.
3. Type a current code from the app.

Ten recovery codes are shown **once**. Keep them where you keep the password. Then sign in afresh with the password and a code. Password, recovery codes and sessions are on the **Account** screen.

## 3. The workspace

The **Help** screen's "First run" guide takes you through it:

1. a project (its first environment, `development`, comes with it);
2. secrets, one by one or by an import of a dotenv file (the preview shows what would change before anything is written);
3. a machine credential for the environment. Its token is shown once.

What a token can read, how to replace one (issue the new one, then revoke the old one) and what to do when a delivery was lost are in `machine-credentials.md`.

## 4. The CLI and an application (WSL or any Linux)

`consumer-local.md`, steps 1 to 10:

- download and check the release `cli-v0.1.2`, then install it;
- name the service and the environment;
- store the token on standard input, into a file only you can read;
- start the application through `secrets-launch.sh`.

To try it without an application of your own, start the fixture in `tests/fixtures/consumers/fastapi-app` or `next-app`.

Then revoke the credential on the workspace's Machine credentials screen and start the application again. It must not start: the CLI exits with `denied` and runs nothing.

## 5. What happened

The **Activity** screen shows who issued and revoked the credential, and each time a person revealed, changed or exported a secret.

## 6. If the server is ever restored

Read `restore.md`, "Between 7 and 8: the owner comes back". A restore resets every account and revokes every token. You get a new reset link (always the kind that enrols a new authenticator), then check one secret you know through a private tunnel before the service opens again. Every application needs a new token (`consumer-local.md`, "After a restore").

## 7. What the service does not do

`known-limits.md`. The same list is on the Help screen.
