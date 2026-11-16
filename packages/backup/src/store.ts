// The object store the audit archive and the backup pairs write through
// (Run 6.2, P-112): R2 in production, a local directory in tests of the code
// that uses it (the bucket's own behaviour is the cloud tests').
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { deleteObjectsChecked, s3ClientFor, type DeleteOutcome, type R2Credentials } from "./r2.ts";

export interface ObjectStore {
  /** Writes one object; `sha256` (hex) and `bytes` describe the body exactly. */
  put(key: string, body: Buffer | Readable, opts: { bytes: number; sha256: string }): Promise<void>;
  /** The object's bytes; throws when it is absent. */
  get(key: string): Promise<Readable>;
  /** Its size, or null when absent. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** Every object under the prefix, by key. */
  list(prefix: string): Promise<{ key: string; bytes: number }[]>;
  /** Bulk delete, one outcome per key (never trusts a status). */
  deleteChecked(keys: readonly string[]): Promise<DeleteOutcome[]>;
  /** Aborts multipart uploads under the prefix started more than `olderThanSeconds` ago. */
  abortStaleUploads(prefix: string, olderThanSeconds: number): Promise<number>;
}

/** The SHA-256 (hex) and length of a stream's bytes. */
export async function digestOf(stream: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** The whole stream as one buffer (small objects only: manifests, a day of rows). */
export async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;

function checkKey(key: string): void {
  if (!KEY.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`object store: unusable key ${key.slice(0, 80)}`);
  }
}

/**
 * An R2 bucket as an ObjectStore. A put sends the SHA-256 as the checksum
 * header, so R2 refuses a body that differs from what was hashed.
 */
export function r2Store(
  creds: R2Credentials,
  bucket: string,
  client: S3Client = s3ClientFor(creds),
): ObjectStore {
  return {
    async put(key, body, opts) {
      checkKey(key);
      if (!HEX64.test(opts.sha256)) throw new Error("object store: sha256 must be 64 hex digits");
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: opts.bytes,
          ChecksumSHA256: Buffer.from(opts.sha256, "hex").toString("base64"),
        }),
      );
    },
    async get(key) {
      checkKey(key);
      const answer = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (answer.Body === undefined) throw new Error(`object store: ${key} has no body`);
      return answer.Body as Readable;
    },
    async head(key) {
      checkKey(key);
      try {
        const answer = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bytes: answer.ContentLength ?? 0 };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) return null;
        throw error;
      }
    },
    async list(prefix) {
      const found: { key: string; bytes: number }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const entry of page.Contents ?? []) {
          if (entry.Key !== undefined) found.push({ key: entry.Key, bytes: entry.Size ?? 0 });
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
    deleteChecked(keys) {
      return deleteObjectsChecked(client, bucket, [...keys]);
    },
    async abortStaleUploads(prefix, olderThanSeconds) {
      const answer = await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
      );
      const cutoff = Date.now() - olderThanSeconds * 1000;
      let aborted = 0;
      for (const upload of answer.Uploads ?? []) {
        if (upload.Key === undefined || upload.UploadId === undefined) continue;
        if ((upload.Initiated?.getTime() ?? Date.now()) > cutoff) continue;
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
        aborted += 1;
      }
      return aborted;
    },
  };
}

/**
 * The S3 credentials of an R2 token installed on a host: three files
 * `account-id`, `access-key-id`, `secret-access-key` in one directory. Errors
 * name the file, never its content.
 */
export function credentialsFromDirectory(directory: string): R2Credentials {
  const read = (name: string): string => {
    let value: string;
    try {
      value = readFileSync(join(directory, name), "utf8").trim();
    } catch {
      throw new Error(`R2 credentials: ${name} cannot be read in ${directory}`);
    }
    if (value === "") throw new Error(`R2 credentials: ${name} is empty in ${directory}`);
    return value;
  };
  return {
    accountId: read("account-id"),
    accessKeyId: read("access-key-id"),
    secretAccessKey: read("secret-access-key"),
  };
}

/** A local directory as an ObjectStore. A put checks the digest as R2's checksum header does. */
export function directoryStore(root: string): ObjectStore {
  const pathOf = (key: string): string => {
    checkKey(key);
    return join(root, ...key.split("/"));
  };
  const walk = (directory: string): string[] =>
    existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? walk(path) : [path];
        })
      : [];
  return {
    async put(key, body, opts) {
      const bytes = Buffer.isBuffer(body) ? body : await bytesOf(body);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== opts.sha256 || bytes.length !== opts.bytes) {
        throw new Error(`object store: the body of ${key} does not match its digest`);
      }
      const path = pathOf(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.partial`, bytes);
      renameSync(`${path}.partial`, path);
    },
    get(key) {
      const path = pathOf(key);
      if (!existsSync(path)) return Promise.reject(new Error(`object store: ${key} is absent`));
      return Promise.resolve(createReadStream(path));
    },
    head(key) {
      const path = pathOf(key);
      return Promise.resolve(existsSync(path) ? { bytes: statSync(path).size } : null);
    },
    list(prefix) {
      return Promise.resolve(
        walk(root)
          .filter((path) => !path.endsWith(".partial"))
          .map((path) => ({
            key: relative(root, path).split(sep).join("/"),
            bytes: statSync(path).size,
          }))
          .filter((entry) => entry.key.startsWith(prefix))
          .sort((a, b) => a.key.localeCompare(b.key)),
      );
    },
    deleteChecked(keys) {
      return Promise.resolve(
        keys.map((key): DeleteOutcome => {
          const path = pathOf(key);
          if (!existsSync(path)) return { key, deleted: false, errorCode: "NoSuchKey" };
          rmSync(path);
          return { key, deleted: true };
        }),
      );
    },
    abortStaleUploads() {
      return Promise.resolve(0);
    },
  };
}
