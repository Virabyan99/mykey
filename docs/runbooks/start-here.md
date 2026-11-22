# Start here — the owner's first run

One page in the order the owner meets the service, from a reset link to an application that starts with its secrets and no `.env` file. Each step names the screen or the runbook that holds the detail. Use synthetic values only until Gate R is signed.

On staging the address is `https://mykey-staging.nomikey.com`. On production the first account is made by the operator's bootstrap (`operator-accounts.md`, "Bootstrap of the owner"), and you enrol the authenticator after your first sign-in, through the operator's private link (`production.md`, "The first opening"), not on a reset page. Everything after step 2 is the same.

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

After the sign-in you land on **Home**. Its **Getting started** checklist has six steps and marks each one from what the service knows (the CLI step stays "Not checked": the service cannot see your computer):

1. a project (its first environment, `development`, comes with it);
2. secrets, one by one or by an import of a dotenv file (the preview shows what would change before anything is written);
3. a machine credential for the environment. Its token is shown once.

The sidebar on the left holds Home, your projects and their environments, and each environment's sections. The breadcrumbs at the top name where you are, with a **Copy** button for the organization's, the project's and the environment's ids. **Ctrl K** (or `/`) goes to any page, project, environment or help article. The **?** button at the top of every page opens that page's help, and the **Help centre** has the rest.

What a token can read, how to replace one (issue the new one, then revoke the old one) and what to do when a delivery was lost are in `machine-credentials.md`.

## 4. The CLI and an application (WSL or any Linux)

Open the environment's **Connect an application** page (in the sidebar, under the environment). It shows `consumer-local.md`'s own commands, step by step, with this service's address, the project's id and the environment's name already filled in, and a **Copy** button on each block. The token is never filled in. A second tab has the same for a server (`consumer-deploy.md`). In short:

- download and check the release `cli-v0.1.2`, then install it. The repository is public: step 1 uses `curl`, and `gh` is the alternative;
- name the service and the environment:
  - the service is this page's address (on staging `https://mykey-staging.nomikey.com`);
  - the **project's id** is shown with a Copy button in the breadcrumbs and on the project's page (it is also the part of the address after `/p/`);
  - the environment is its name, `development`;
- store the token on standard input, into a file only you can read. The pasted token stays on the screen, so never copy that terminal into a chat or a screenshot (`stty -echo` keeps it off);
- start the application through `secrets-launch.sh`.

Without an application of your own, step 9 has a command that only lists the names it was started with.

Then revoke the credential on the workspace's Machine credentials screen and start the application again. It must not start: the CLI exits with `denied` and runs nothing.

## 5. What happened

The **Activity** screen shows who issued and revoked the credential, and each time a person revealed, changed or exported a secret.

## 6. If the server is ever restored

If the server is ever rebuilt from a backup, this is what it asks of you:

1. Every sign-in and every machine token stops working. Nothing old is let back in.
2. The operator gives you a new reset link, the same kind as in step 1. It always enrols a new authenticator.
3. The operator opens a private link that works only from their computer. Through it, you set a new password, enrol the new authenticator, open **one secret whose value you know** and check it, and try **one change**, which must be refused ("The service is not open"). Then you sign out.
4. You tell the operator in one line that the value was right. Only then does the service open.
5. Every application gets a new token (`consumer-local.md`, "After a restore").

The operator's side of the same steps is `restore.md`, "Between 7 and 8: the owner comes back".

## 7. What the service does not do

`known-limits.md`. The same list is the Help centre's article "What MyKey does not do".
