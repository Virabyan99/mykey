// The staging owner's session through the public name (Run 3.8 Task D). The
// first call enrolls TOTP (the owner is `enrollment_pending` since Run 3.2)
// and keeps the seed and the recovery codes in workstation custody under
// ~/.mykey/secrets/hosts/staging/ (0600, never printed); every later call
// completes sign-in with a code of the stored seed. Synthetic owner only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

  // First use: enroll and activate; the seed and the codes go to custody only.
  const enrolled = await publicRequest("POST", "/v1/auth/totp/enroll", {
    body: {},
    cookie: passwordCookie,
  });
  if (enrolled.status !== 200) throw new Error(`enroll answered ${String(enrolled.status)}`);
  const { secret } = JSON.parse(enrolled.body) as { secret: string };
  registerSecret(secret);
  writeCustody("owner-totp-seed", secret);
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  const activated = await publicRequest("POST", "/v1/auth/totp/activate", {
    body: { code: await freshCode(seed) },
    cookie: passwordCookie,
  });
  if (activated.status !== 200) throw new Error(`activate answered ${String(activated.status)}`);
  const { recoveryCodes } = JSON.parse(activated.body) as { recoveryCodes: string[] };
  for (const code of recoveryCodes) registerSecret(code);
  writeCustody("owner-recovery-codes", recoveryCodes.join("\n"));
  return { cookie: sessionPair(activated) };
}
