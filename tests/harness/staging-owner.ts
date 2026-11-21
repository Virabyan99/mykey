// The staging owner's session through the public name (Run 3.8 Task D). The
// first call enrolls TOTP (the owner is `enrollment_pending` since Run 3.2)
// and keeps the seed and the recovery codes in workstation custody under
// ~/.mykey/secrets/hosts/staging/ (0600, never printed); every later call
// completes sign-in with a code of the stored seed. Synthetic owner only.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { codeAt, stepAt } from "@mykey/auth";
import * as OTPAuth from "otpauth";
import { loadHosts, registerSecret } from "./staging.ts";

export const STAGING_OWNER_EMAIL = "owner@mykey-staging.invalid";

const custody = (name: string): string =>
  join(homedir(), ".mykey", "secrets", "hosts", "staging", name);

export const STAGING_ORIGIN = `https://${loadHosts().staging.hostname}`;

export interface PublicAnswer {
  status: number;
  headers: Headers;
  body: string;
  /** The body as received (an export attachment is compared by digest). */
  bytes: Buffer;
  cookies: string[];
}

/** One request to the public name with the product's Origin. */
export async function publicRequest(
  method: string,
  path: string,
  init: {
    body?: unknown;
    /** A text/plain body (a dotenv file, Run 4.7) instead of JSON. */
    text?: string | Uint8Array;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<PublicAnswer> {
  const headers: Record<string, string> = {
    origin: STAGING_ORIGIN,
    "sec-fetch-site": "same-origin",
    ...init.headers,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.text !== undefined) headers["content-type"] = "text/plain; charset=utf-8";
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const payload = init.text ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const response = await fetch(`${STAGING_ORIGIN}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "manual",
  });
  const cookies = response.headers.getSetCookie();
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    body: bytes.toString("utf8"),
    bytes,
    cookies,
  };
}

/** The `name=value` pair of the session cookie an answer set. */
export function sessionPair(answer: PublicAnswer): string {
  for (const cookie of answer.cookies) {
    const pair = cookie.split(";")[0] ?? "";
    if (pair.startsWith("__Secure-better-auth.session_token=")) {
      registerSecret(pair.slice(pair.indexOf("=") + 1));
      return pair;
    }
  }
  // The error code only: an answer without a cookie holds no secret.
  const code = /"code":"([a-z_]+)"/.exec(answer.body)?.[1] ?? "none";
  throw new Error(`no session cookie (HTTP ${String(answer.status)} ${code})`);
}

export function readCustody(name: string): string | null {
  const path = custody(name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

export function writeCustody(name: string, value: string): void {
  writeFileSync(custody(name), `${value}\n`, { mode: 0o600 });
}

/** A code of a step not used before by this workstation (each step verifies once). */
export async function freshCode(seed: Uint8Array): Promise<string> {
  const last = Number(readCustody("owner-totp-last-step") ?? "0");
  while (stepAt(new Date()) <= last) await sleep(1000);
  const step = stepAt(new Date());
  writeCustody("owner-totp-last-step", String(step));
  return codeAt(seed, step);
}

export async function stagingOwnerSession(): Promise<{ cookie: string }> {
  const password = readCustody("owner-password");
  if (password === null) throw new Error("no owner-password in workstation custody (Run 3.2)");
  registerSecret(password);
  const signedIn = await publicRequest("POST", "/v1/auth/sign-in/email", {
    body: { email: STAGING_OWNER_EMAIL, password },
  });
  if (signedIn.status !== 200) throw new Error(`sign-in answered ${String(signedIn.status)}`);
  const passwordCookie = sessionPair(signedIn);

  const storedSeed = readCustody("owner-totp-seed");
  if (storedSeed !== null) {
    registerSecret(storedSeed);
    const seed = OTPAuth.Secret.fromBase32(storedSeed).bytes;
    const verified = await publicRequest("POST", "/v1/auth/totp/verify", {
      body: { code: await freshCode(seed) },
      cookie: passwordCookie,
    });
    if (verified.status !== 200) throw new Error(`verify answered ${String(verified.status)}`);
    return { cookie: sessionPair(verified) };
  }

  // First use: enroll and activate.
  return { cookie: sessionPair(await enrollOwner(passwordCookie)) };
}

/**
 * Enrolls and activates a new authenticator on a session that may enroll (a
 * password sign-in of an `enrollment_pending` owner, or the session an `mfa`
 * reset hands back). The seed and the codes go to custody only. Answers the
 * activation's answer: after a reset it ends every session (P-51), so it may
 * carry no cookie.
 */
async function enrollOwner(cookie: string): Promise<PublicAnswer> {
  const enrolled = await publicRequest("POST", "/v1/auth/totp/enroll", { body: {}, cookie });
  if (enrolled.status !== 200) throw new Error(`enroll answered ${String(enrolled.status)}`);
  const { secret } = JSON.parse(enrolled.body) as { secret: string };
  registerSecret(secret);
  writeCustody("owner-totp-seed", secret);
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  const activated = await publicRequest("POST", "/v1/auth/totp/activate", {
    body: { code: await freshCode(seed) },
    cookie,
  });
  if (activated.status !== 200) throw new Error(`activate answered ${String(activated.status)}`);
  const { recoveryCodes } = JSON.parse(activated.body) as { recoveryCodes: string[] };
  for (const code of recoveryCodes) registerSecret(code);
  writeCustody("owner-recovery-codes", recoveryCodes.join("\n"));
  return activated;
}

/** Runs `host.ts staging ops <argv>` (the operator's own path, over the tunnel). */
export function stagingOps(argv: string[]): { code: number | null; stdout: string } {
  const result = spawnSync(process.execPath, ["scripts/host.ts", "staging", "ops", ...argv], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { code: result.status, stdout: result.stdout };
}

/**
 * Run 3.10, moved here in Run 8.4: `ops reset-account` for the staging owner.
 * Answers the link and its token (both registered as secrets); the link file
 * is shredded.
 */
export function initiateOwnerReset(kind: "password" | "mfa"): { link: string; token: string } {
  const run = stagingOps(["reset-account", "--email", STAGING_OWNER_EMAIL, "--kind", kind]);
  if (run.code !== 0) throw new Error(`reset-account exited ${String(run.code)}`);
  const path = /link in (\S+);/.exec(run.stdout)?.[1];
  if (path === undefined) throw new Error("reset-account printed no link file");
  const link = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  const token = /#t=([A-Za-z0-9_-]{43})&k=/.exec(link)?.[1];
  if (token === undefined) throw new Error("the link file holds no token");
  registerSecret(link);
  registerSecret(token);
  return { link, token };
}

/**
 * Run 8.8 Step 3: gives the staging owner back to the workstation after a
 * person used the account with their own password and authenticator. An
 * `mfa` reset, completed as the reset page does: a new password, then a new
 * authenticator enrolled on the session the reset hands back (a password
 * sign-in is refused until then). Password, seed and recovery codes go to
 * custody only, never printed; a fresh sign-in proves them.
 */
export async function reestablishStagingOwner(): Promise<void> {
  const { token } = initiateOwnerReset("mfa");
  const newPassword = `staging-${randomBytes(18).toString("base64url")}`;
  registerSecret(newPassword);
  const done = await publicRequest("POST", "/v1/auth/reset/complete", {
    body: { token, newPassword },
  });
  if (done.status !== 200) throw new Error(`reset/complete answered ${String(done.status)}`);
  const { next } = JSON.parse(done.body) as { next: string };
  if (next !== "enroll") throw new Error(`an mfa reset answered next "${next}", not "enroll"`);
  writeCustody("owner-password", newPassword);
  // The old seed and codes belong to an enrollment the reset removed.
  rmSync(custody("owner-totp-seed"), { force: true });
  rmSync(custody("owner-recovery-codes"), { force: true });
  await enrollOwner(sessionPair(done));
  await stagingOwnerSession();
}

/**
 * Completes a password reset with a new password and a code of the stored
 * seed; the new password goes to custody. Answers it (registered as a secret).
 */
export async function completeOwnerPasswordReset(token: string): Promise<string> {
  const stored = readCustody("owner-totp-seed");
  if (stored === null) throw new Error("no owner-totp-seed in workstation custody");
  const seed = OTPAuth.Secret.fromBase32(stored).bytes;
  const newPassword = `staging-${randomBytes(18).toString("base64url")}`;
  registerSecret(newPassword);
  const done = await publicRequest("POST", "/v1/auth/reset/complete", {
    body: { token, newPassword, code: await freshCode(seed) },
  });
  if (done.status !== 200) throw new Error(`reset/complete answered ${String(done.status)}`);
  writeCustody("owner-password", newPassword);
  return newPassword;
}
