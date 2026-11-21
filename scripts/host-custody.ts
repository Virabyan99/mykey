// Run 9.7 Task A (Session 8's review R4-2, R4-3, R4-10): the workstation's
// custody of a host's OpenBao root tokens, and generate-root.
//
//   ~/.mykey/custody/<host>/openbao-init.json   the answer that opens the
//       host's OpenBao now: its root token and its recovery key (P-35).
//   ~/.mykey/custody/<host>/openbao-init.<UTC stamp>.json   an answer kept
//       beside it, never overwritten: a new server's own init answer while
//       the copy still holds the lost host's (a host restored onto its own
//       reinstalled server, R4-10), or the copy a restore's opening replaced
//       (R4-2).
//   ~/.mykey/secrets/hosts/<host>/restore-root-token   the restore's own root
//       token, from the moment it is minted until restore-verify --open (R4-3).
//
// After a restore the snapshot carries the source's recovery configuration:
// generate-root with the source's recovery key makes the restored OpenBao's
// next root token, and the target's custody copy becomes the source's answer
// with that token. Values never reach a log: the callers register them.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The workstation's copy of a host's init answer (P-35). */
export function custodyCopyPath(host: string, home: string = homedir()): string {
  return join(home, ".mykey", "custody", host, "openbao-init.json");
}

/** Where the restore keeps its own root token between `restore` and `restore-verify --open`. */
export function restoreRootTokenPath(host: string, home: string = homedir()): string {
  return join(home, ".mykey", "secrets", "hosts", host, "restore-root-token");
}

const stampOf = (at: Date): string =>
  at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-");

/** A dated answer beside the custody copy (never overwritten). */
export function datedCustodyPath(host: string, at: Date, home: string = homedir()): string {
  return join(home, ".mykey", "custody", host, `openbao-init.${stampOf(at)}.json`);
}

const DATED = /^openbao-init\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;

/** The dated answers of a host, newest first. */
export function datedCustodyCopies(
  host: string,
  home: string = homedir(),
): { path: string; text: string }[] {
  const directory = dirname(custodyCopyPath(host, home));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => DATED.test(name))
    .sort()
    .reverse()
    .map((name) => ({
      path: join(directory, name),
      text: readFileSync(join(directory, name), "utf8"),
    }));
}

/**
 * Where bao-init writes the host's init answer (R4-10): the custody copy when
 * there is none; nothing when the copy or a dated one already holds this very
 * answer; otherwise a dated path beside the copy, which stays (it may be the
 * lost host's, which a restore onto this server needs). Only a dated path
 * that already holds another answer is refused.
 */
export function custodyInitPlan(input: {
  current: string | null;
  dated: readonly { path: string; text: string }[];
  answer: string;
  datedPath: string;
}): { write: string | null } {
  const { current, dated, answer, datedPath } = input;
  if (current === null) return { write: join(dirname(datedPath), "openbao-init.json") };
  if (current === answer || dated.some((copy) => copy.text === answer)) return { write: null };
  const taken = dated.find((copy) => copy.path === datedPath);
  if (taken !== undefined) {
    throw new Error(`${datedPath} holds another init answer; it is never overwritten`);
  }
  return { write: datedPath };
}

const rootTokenOf = (text: string): string | null => {
  try {
    const token = (JSON.parse(text) as { root_token?: unknown }).root_token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
};

/**
 * The root tokens that may open a host's OpenBao, in the order a restore
 * offers them (R4-3, R4-10): the restore's own kept token (a rerun), the
 * dated init answers newest first (a new server beside a lost host's copy),
 * then the custody copy. The restore uses the first one OpenBao accepts.
 */
export function rootTokenCandidates(
  host: string,
  home: string = homedir(),
): { token: string; from: string }[] {
  const found: { token: string; from: string }[] = [];
  const kept = restoreRootTokenPath(host, home);
  if (existsSync(kept)) {
    const token = readFileSync(kept, "utf8").trim();
    if (token !== "") found.push({ token, from: "restore" });
  }
  for (const copy of datedCustodyCopies(host, home)) {
    const token = rootTokenOf(copy.text);
    if (token !== null)
      found.push({ token, from: `init ${copy.path.split(/[\\/]/).at(-1) ?? ""}` });
  }
  const current = custodyCopyPath(host, home);
  if (existsSync(current)) {
    const token = rootTokenOf(readFileSync(current, "utf8"));
    if (token !== null) found.push({ token, from: "custody" });
  }
  return found;
}

/** generate-root's answer: base64 of the token XOR the one-time password. */
export function decodeGeneratedRoot(encoded: string, otp: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== otp.length) {
    throw new Error(
      `generate-root: the encoded token's length ${String(bytes.length)} is not the one-time password's ${String(otp.length)}`,
    );
  }
  return String.fromCharCode(...Array.from(bytes, (byte, i) => byte ^ otp.charCodeAt(i)));
}

/**
 * One call to OpenBao's sys/ API with a root token the caller holds (the
 * restore's own); the body travels on stdin or in the request.
 */
export type SysCall = (
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * generate-root with one recovery key (the threshold is 1, bao-init), through
 * the authenticated sys/generate-root-token: OpenBao 2.7 disables the
 * unauthenticated sys/generate-root by default (it answers 405). Any attempt
 * in progress is cancelled, a new one gives a nonce and a one-time password,
 * the key completes it, and the answer is decoded. An attempt that does not
 * complete with this key is an error, never a token.
 */
export async function generateRoot(call: SysCall, recoveryKey: string): Promise<string> {
  const expect = (answer: { status: number; body: unknown }, what: string) => {
    if (answer.status !== 200 && answer.status !== 204) {
      throw new Error(`generate-root ${what}: HTTP ${String(answer.status)}`);
    }
    // An authenticated sys/ answer carries its fields under `data`.
    const body = fields(answer.body);
    return "data" in body ? fields(body.data) : body;
  };
  expect(await call("DELETE", "sys/generate-root-token/attempt"), "cancel");
  const attempt = expect(await call("POST", "sys/generate-root-token/attempt", {}), "attempt");
  const nonce = attempt.nonce;
  const otp = attempt.otp;
  if (typeof nonce !== "string" || typeof otp !== "string" || otp === "") {
    throw new Error("generate-root attempt: no nonce or one-time password");
  }
  const update = expect(
    await call("POST", "sys/generate-root-token/update", { key: recoveryKey, nonce }),
    "update",
  );
  if (update.complete !== true || typeof update.encoded_token !== "string") {
    throw new Error("generate-root did not complete with the source's recovery key");
  }
  return decodeGeneratedRoot(update.encoded_token, otp);
}

/** The source's init answer with the restored OpenBao's new root token. */
export function custodyAfterRestore(sourceAnswer: string, rootToken: string): string {
  const answer = JSON.parse(sourceAnswer) as Record<string, unknown>;
  return `${JSON.stringify({ ...answer, root_token: rootToken }, null, 2)}\n`;
}

/** The recovery key of an init answer (the threshold is 1). */
export function recoveryKeyOf(answer: string): string {
  const keys = (JSON.parse(answer) as { recovery_keys_base64?: unknown }).recovery_keys_base64;
  const key = Array.isArray(keys) ? (keys[0] as unknown) : undefined;
  if (typeof key !== "string" || key === "") throw new Error("the init answer has no recovery key");
  return key;
}

/**
 * After a restore's opening (R4-2): the target's custody copy becomes the
 * source's answer with the new root token. The copy it replaces is kept,
 * dated; a dated path that exists is never overwritten.
 */
export function writeCustodyAfterRestore(
  host: string,
  sourceAnswer: string,
  rootToken: string,
  at: Date,
  home: string = homedir(),
): { copy: string; replaced: string | null } {
  const copy = custodyCopyPath(host, home);
  mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
  let replaced: string | null = null;
  if (existsSync(copy)) {
    replaced = datedCustodyPath(host, at, home);
    if (existsSync(replaced)) throw new Error(`${replaced} exists; it is never overwritten`);
    renameSync(copy, replaced);
  }
  writeFileSync(copy, custodyAfterRestore(sourceAnswer, rootToken), { mode: 0o600, flag: "wx" });
  return { copy, replaced };
}
