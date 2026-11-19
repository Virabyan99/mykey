// R2 access (Run 1.9; moved here from the retention fixture in Run 6.2):
// credentials by token name, an S3 client, and a bulk delete that reports what
// happened to each object.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Where credentials are looked up. Tests pass their own; scripts use the defaults. */
export interface CredentialSource {
  env?: Record<string, string | undefined>;
  home?: string;
}

const TOKEN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELDS = ["accountId", "accessKeyId", "secretAccessKey"] as const;

/** `mykey-fixture-upload` → `MYKEY_FIXTURE_UPLOAD`. */
function envPrefix(tokenName: string): string {
  return tokenName.toUpperCase().replaceAll("-", "_");
}

/** The file that holds a token's S3 credentials, outside the repository. */
export function r2CredentialFile(tokenName: string, home: string = homedir()): string {
  return join(home, ".mykey", "secrets", "r2", `${tokenName}.json`);
}

/**
 * Loads the S3 credentials of one R2 token: from the environment first
 * (`MYKEY_R2_ACCOUNT_ID`, `<TOKEN>_ACCESS_KEY_ID`, `<TOKEN>_SECRET_ACCESS_KEY`),
 * then from `~/.mykey/secrets/r2/<tokenName>.json`. Errors name the token and
 * the missing fields, never a value.
 */
export function loadR2Credentials(tokenName: string, source: CredentialSource = {}): R2Credentials {
  if (!TOKEN_NAME.test(tokenName)) throw new Error("R2 credentials: not a valid token name");
  const env = source.env ?? process.env;
  const prefix = envPrefix(tokenName);
  const fromEnv = {
    accountId: env.MYKEY_R2_ACCOUNT_ID,
    accessKeyId: env[`${prefix}_ACCESS_KEY_ID`],
    secretAccessKey: env[`${prefix}_SECRET_ACCESS_KEY`],
  };
  if (fromEnv.accountId && fromEnv.accessKeyId && fromEnv.secretAccessKey) {
    return {
      accountId: fromEnv.accountId,
      accessKeyId: fromEnv.accessKeyId,
      secretAccessKey: fromEnv.secretAccessKey,
    };
  }
  const file = r2CredentialFile(tokenName, source.home);
  if (!existsSync(file)) {
    throw new Error(`R2 credentials for ${tokenName}: not in the environment and no file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`R2 credentials for ${tokenName}: the file is not JSON`);
  }
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const missing = FIELDS.filter((field) => {
    const value = record[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`R2 credentials for ${tokenName}: the file lacks ${missing.join(", ")}`);
  }
  return {
    accountId: record.accountId as string,
    accessKeyId: record.accessKeyId as string,
    secretAccessKey: record.secretAccessKey as string,
  };
}

/**
 * Loads the Cloudflare API token of an R2 token that also configures buckets
 * (`mykey-r2-admin`): from `<TOKEN>_API_TOKEN` first, then the `apiToken` field
 * of its credential file. The S3 secret cannot stand in for it: it is a hash.
 */
export function loadR2ApiToken(tokenName: string, source: CredentialSource = {}): string {
  if (!TOKEN_NAME.test(tokenName)) throw new Error("R2 credentials: not a valid token name");
  const fromEnv = (source.env ?? process.env)[`${envPrefix(tokenName)}_API_TOKEN`];
  if (fromEnv) return fromEnv;
  const file = r2CredentialFile(tokenName, source.home);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { apiToken?: unknown } | null;
      if (typeof parsed?.apiToken === "string" && parsed.apiToken.length > 0) {
        return parsed.apiToken;
      }
    } catch {
      // Falls through to the error below, which names no content of the file.
    }
  }
  throw new Error(`R2 API token for ${tokenName}: not in the environment or the file`);
}

/** The S3 endpoint of an R2 account. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** An S3 client for R2, with the options of Cloudflare's aws-sdk-js-v3 example. */
export function s3ClientFor(creds: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(creds.accountId),
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

export interface DeleteOutcome {
  key: string;
  deleted: boolean;
  errorCode?: string;
}

/** The parts of a DeleteObjects answer that say what happened to each key. */
export interface DeleteObjectsAnswer {
  Deleted?: { Key?: string | undefined }[] | undefined;
  Errors?: { Key?: string | undefined; Code?: string | undefined }[] | undefined;
}

/**
 * One outcome per requested key, in the order asked. A key counts as deleted only
 * when the answer lists it under `Deleted` and not under `Errors`: R2 answers a
 * bulk delete with HTTP 200 even when it refused every object.
 */
export function deleteOutcomes(keys: string[], answer: DeleteObjectsAnswer): DeleteOutcome[] {
  const errors = new Map<string, string>();
  for (const error of answer.Errors ?? []) {
    if (error.Key !== undefined) errors.set(error.Key, error.Code ?? "Unknown");
  }
  const deleted = new Set<string>();
  for (const entry of answer.Deleted ?? []) {
    if (entry.Key !== undefined) deleted.add(entry.Key);
  }
  return keys.map((key) => {
    const errorCode = errors.get(key);
    if (errorCode !== undefined) return { key, deleted: false, errorCode };
    if (deleted.has(key)) return { key, deleted: true };
    return { key, deleted: false, errorCode: "NotReported" };
  });
}

/** Bulk delete that never trusts the HTTP status: see {@link deleteOutcomes}. */
export async function deleteObjectsChecked(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<DeleteOutcome[]> {
  if (keys.length === 0) return [];
  const answer = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      // Quiet mode would leave successes out of the answer; every key must be reported.
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
    }),
  );
  return deleteOutcomes(keys, answer);
}
