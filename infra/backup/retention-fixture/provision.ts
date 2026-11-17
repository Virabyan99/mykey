// Provisions R2 for MyKey: four buckets, their lock rules and eight scoped tokens.
// Idempotent. Run: node infra/backup/retention-fixture/provision.ts --account <account id>
//
// It reads the bootstrap Cloudflare token from ~/.mykey/secrets/cloudflare/bootstrap-token,
// writes each new token's credentials to ~/.mykey/secrets/r2/<token name>.json and prints
// token names and ids only. No token value is printed or written to the repository.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadR2ApiToken, r2CredentialFile, type R2Credentials } from "./r2.ts";

export const BUCKETS = [
  "mykey-prod-pairs",
  "mykey-staging-pairs",
  "mykey-audit-archive",
  "mykey-retention-fixture",
] as const;
export type BucketName = (typeof BUCKETS)[number];

export interface LockRule {
  id: string;
  enabled: boolean;
  prefix: string;
  condition: { type: "Age"; maxAgeSeconds: number };
}

const ageRule = (id: string, prefix: string, maxAgeSeconds: number): LockRule => ({
  id,
  enabled: true,
  prefix,
  condition: { type: "Age", maxAgeSeconds },
});

/** The lock rules each bucket must have. An empty list means "no rule today". */
export const LOCK_RULES: Record<BucketName, LockRule[]> = {
  "mykey-prod-pairs": [ageRule("pairs-30d", "pairs/", 2_592_000)],
  // Run 6.5 (P-119): set once the spike objects were removed (17 Nov 2026).
  "mykey-staging-pairs": [ageRule("pairs-30d", "pairs/", 2_592_000)],
  // Run 6.2 (P-112, D-48): a year on production's segments, a month on staging's
  // (synthetic rows: a year would hold the bucket for nothing), ten minutes for
  // the cloud test's probe objects.
  "mykey-audit-archive": [
    ageRule("audit-prod-365d", "prod/", 31_536_000),
    ageRule("audit-staging-30d", "staging/", 2_592_000),
    ageRule("audit-probe-10m", "probe/", 600),
  ],
  "mykey-retention-fixture": [
    ageRule("fixture-pairs-4d", "pairs/", 345_600),
    ageRule("fixture-probe-10m", "probe/", 600),
  ],
};

export interface TokenSpec {
  name: string;
  permissionGroup: "Workers R2 Storage Write" | "Workers R2 Storage Bucket Item Write";
  /** The one bucket whose objects the token reaches; absent for the account-wide admin token. */
  bucket?: BucketName;
}

const objectToken = (name: string, bucket: BucketName): TokenSpec => ({
  name,
  permissionGroup: "Workers R2 Storage Bucket Item Write",
  bucket,
});

export const TOKEN_PLAN: TokenSpec[] = [
  { name: "mykey-r2-admin", permissionGroup: "Workers R2 Storage Write" },
  objectToken("mykey-prod-pairs-upload", "mykey-prod-pairs"),
  objectToken("mykey-prod-pairs-cleanup", "mykey-prod-pairs"),
  objectToken("mykey-staging-pairs-upload", "mykey-staging-pairs"),
  objectToken("mykey-staging-pairs-cleanup", "mykey-staging-pairs"),
  objectToken("mykey-audit-archive-upload", "mykey-audit-archive"),
  objectToken("mykey-fixture-upload", "mykey-retention-fixture"),
  objectToken("mykey-fixture-cleanup", "mykey-retention-fixture"),
];

/** The resource name of one bucket in the default jurisdiction. */
export function bucketResource(accountId: string, bucket: string): string {
  return `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`;
}

export interface TokenPolicy {
  effect: "allow";
  resources: Record<string, "*">;
  permission_groups: { id: string }[];
}

/** The single policy of a token: one permission group on one bucket, or on the account. */
export function tokenPolicies(
  spec: TokenSpec,
  accountId: string,
  permissionGroupId: string,
): TokenPolicy[] {
  const resource =
    spec.bucket === undefined
      ? `com.cloudflare.api.account.${accountId}`
      : bucketResource(accountId, spec.bucket);
  return [
    {
      effect: "allow",
      resources: { [resource]: "*" },
      permission_groups: [{ id: permissionGroupId }],
    },
  ];
}

/** S3 credentials of an R2 token: access key = token id, secret = SHA-256 hex of its value. */
export function s3CredentialsFor(
  accountId: string,
  tokenId: string,
  tokenValue: string,
): R2Credentials {
  return {
    accountId,
    accessKeyId: tokenId,
    secretAccessKey: createHash("sha256").update(tokenValue).digest("hex"),
  };
}

const ruleKey = (rule: LockRule): string =>
  JSON.stringify([
    rule.id,
    rule.enabled,
    rule.prefix,
    rule.condition.type,
    rule.condition.maxAgeSeconds,
  ]);

/** Whether two rule lists say the same thing, whatever their order or extra fields. */
export function sameRules(wanted: LockRule[], actual: LockRule[]): boolean {
  if (wanted.length !== actual.length) return false;
  const left = wanted.map(ruleKey).sort();
  const right = actual.map(ruleKey).sort();
  return left.every((key, index) => key === right[index]);
}

/**
 * Why the live rules of a bucket must not be replaced by the wanted ones, or
 * `undefined` when replacing them loses nothing. A live, enabled rule is lost
 * when the plan does not name it, shortens it, disables it or moves its prefix.
 * The plan may be out of date; a lock is never weakened on its word alone.
 */
export function lockRuleLoss(wanted: LockRule[], actual: LockRule[]): string | undefined {
  for (const live of actual) {
    if (!live.enabled) continue;
    const planned = wanted.find((rule) => rule.id === live.id);
    if (planned === undefined) return `live rule ${live.id} is not in the plan`;
    if (!planned.enabled) return `live rule ${live.id}: the plan would disable it`;
    if (planned.prefix !== live.prefix)
      return `live rule ${live.id}: the plan would move its prefix`;
    if (planned.condition.maxAgeSeconds < live.condition.maxAgeSeconds) {
      return `live rule ${live.id}: the plan would shorten it`;
    }
  }
  return undefined;
}

export type TokenAction = "create" | "keep" | "leave" | "roll";

/**
 * What to do with one planned token. An existing token is rolled only when it is
 * named with `--roll`: rolling ends the credentials every other holder has. One
 * whose credential file is not here (it may live on a server) is left alone.
 */
export function tokenAction(input: {
  name: string;
  exists: boolean;
  fileComplete: boolean;
  roll: string[];
}): TokenAction {
  if (!input.exists) return "create";
  if (input.roll.includes(input.name)) return "roll";
  return input.fileComplete ? "keep" : "leave";
}

/** The bucket-scoped tokens of the plan with no recorded lock-change attempt. */
export function tokensWithoutAttempt(attempts: { token: string }[]): string[] {
  const recorded = new Set(attempts.map((attempt) => attempt.token));
  return TOKEN_PLAN.filter((spec) => spec.bucket !== undefined && !recorded.has(spec.name)).map(
    (spec) => spec.name,
  );
}

// ---------------------------------------------------------------------------
// The evidence file both scripts and the cloud tests share.

export const EVIDENCE_FILE = resolve(
  import.meta.dirname,
  "../../../docs/evidence/session-1/retention-fixture.json",
);

/** What happened when a bucket-scoped token tried to set the lock rule of its bucket. */
export interface LockChangeAttempt {
  token: string;
  bucket: string;
  /** The token was active at Cloudflare when the attempt was made. */
  verifiedActive: boolean;
  /** HTTP status of `PUT …/r2/buckets/<bucket>/lock` with the token as bearer. */
  status: number;
  code: number | null;
  denied: boolean;
  deniedAt: string;
}

export interface FixtureObject {
  key: string;
  bytes: number;
  etag: string;
  /** The LastModified value R2 returned, UTC. */
  uploadedAt: string;
  captureTime: string | null;
  pairId: string | null;
  lockRule: string | null;
  lockExpiresAt: string | null;
}

export interface Checkpoint {
  id: string;
  what: string;
  notBefore: string | null;
  status: "pending" | "observed";
  observed?: Record<string, unknown>;
}

export interface RetentionFixture {
  version: 1;
  accountId: string;
  provisionedAt: string;
  buckets: { name: string; lockRules: LockRule[] }[];
  tokens: { name: string; bucket: string | null; permissionGroup: string }[];
  lockChangeAttempts: LockChangeAttempt[];
  upload?: Record<string, unknown>;
  objects: FixtureObject[];
  checkpoints: Checkpoint[];
}

export function readEvidence(file: string = EVIDENCE_FILE): RetentionFixture | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as RetentionFixture;
}

export function writeEvidence(evidence: RetentionFixture, file: string = EVIDENCE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Cloudflare REST API. The bearer is never logged; errors carry status and codes only.

const API = "https://api.cloudflare.com/client/v4";

interface CfAnswer<T> {
  status: number;
  date: string | null;
  success: boolean;
  result: T | null;
  errors: { code: number; message: string }[];
}

export async function cloudflare<T>(
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfAnswer<T>> {
  // A value with a line break makes the runtime quote the whole header in its error.
  if (!/^[A-Za-z0-9_-]+$/.test(bearer)) {
    throw new Error("Cloudflare API: the token is not one line of token characters");
  }
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // The cause is dropped on purpose: it may quote the request.
    throw new Error(`Cloudflare API: ${method} ${path} could not be sent`);
  }
  let parsed: { success?: boolean; result?: T; errors?: { code: number; message: string }[] } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    // An answer without JSON is reported by its status alone.
  }
  return {
    status: response.status,
    date: response.headers.get("date"),
    success: parsed.success === true,
    result: parsed.result ?? null,
    errors: parsed.errors ?? [],
  };
}

function must<T>(answer: CfAnswer<T>, what: string): T {
  if (!answer.success || answer.result === null) {
    const codes = answer.errors.map((error) => `${String(error.code)} ${error.message}`).join("; ");
    throw new Error(`${what}: HTTP ${String(answer.status)} ${codes}`);
  }
  return answer.result;
}

/** The lock rules of a bucket as Cloudflare reports them. */
export async function readLockRules(
  bearer: string,
  accountId: string,
  bucket: string,
): Promise<LockRule[]> {
  const result = must(
    await cloudflare<{ rules?: LockRule[] }>(
      bearer,
      "GET",
      `/accounts/${accountId}/r2/buckets/${bucket}/lock`,
    ),
    `read lock rules of ${bucket}`,
  );
  return (result.rules ?? []).map((rule) => ({
    id: rule.id,
    enabled: rule.enabled,
    prefix: rule.prefix,
    condition: { type: rule.condition.type, maxAgeSeconds: rule.condition.maxAgeSeconds },
  }));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function ensureBucket(bearer: string, accountId: string, bucket: string): Promise<string> {
  const found = await cloudflare<unknown>(
    bearer,
    "GET",
    `/accounts/${accountId}/r2/buckets/${bucket}`,
  );
  if (found.success) return "exists";
  if (found.status !== 404) must(found, `look up bucket ${bucket}`);
  must(
    await cloudflare<unknown>(bearer, "POST", `/accounts/${accountId}/r2/buckets`, {
      name: bucket,
      locationHint: "eeur",
    }),
    `create bucket ${bucket}`,
  );
  return "created";
}

async function ensureLockRules(
  bearer: string,
  accountId: string,
  bucket: BucketName,
): Promise<{ rules: LockRule[]; action: string }> {
  const wanted = LOCK_RULES[bucket];
  let rules = await readLockRules(bearer, accountId, bucket);
  let action = "unchanged";
  if (!sameRules(wanted, rules)) {
    const loss = lockRuleLoss(wanted, rules);
    if (loss !== undefined) {
      throw new Error(`lock rules of ${bucket} are left alone: ${loss}. Change them by hand.`);
    }
    must(
      await cloudflare<unknown>(bearer, "PUT", `/accounts/${accountId}/r2/buckets/${bucket}/lock`, {
        rules: wanted,
      }),
      `set lock rules of ${bucket}`,
    );
    rules = await readLockRules(bearer, accountId, bucket);
    action = "set";
  }
  if (!sameRules(wanted, rules)) throw new Error(`lock rules of ${bucket} do not read back`);
  return { rules, action };
}

interface TokenListEntry {
  id: string;
  name: string;
  status: string;
}

async function listTokens(bearer: string): Promise<TokenListEntry[]> {
  const all: TokenListEntry[] = [];
  for (let page = 1; ; page += 1) {
    const batch = must(
      await cloudflare<TokenListEntry[]>(
        bearer,
        "GET",
        `/user/tokens?per_page=50&page=${String(page)}`,
      ),
      "list tokens",
    );
    // Stops on an empty page, not a short one: the page size is the server's to choose.
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function credentialFileComplete(spec: TokenSpec, tokenId: string, home: string): boolean {
  const file = r2CredentialFile(spec.name, home);
  if (!existsSync(file)) return false;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const s3 = stored.accessKeyId === tokenId && typeof stored.secretAccessKey === "string";
    return spec.bucket === undefined ? s3 && typeof stored.apiToken === "string" : s3;
  } catch {
    return false;
  }
}

/**
 * With a bucket-scoped token as bearer, tries to set the bucket's lock rules to
 * what they already are. A token that could do this could also shorten the lock,
 * so the expected answer is a refusal. The body equals the current rules, so an
 * unexpected success changes nothing.
 */
async function attemptLockChange(
  tokenValue: string,
  accountId: string,
  spec: TokenSpec & { bucket: BucketName },
): Promise<LockChangeAttempt> {
  let verifiedActive = false;
  for (let attempt = 0; attempt < 15 && !verifiedActive; attempt += 1) {
    const verify = await cloudflare<{ status: string }>(tokenValue, "GET", "/user/tokens/verify");
    verifiedActive = verify.success && verify.result?.status === "active";
    if (!verifiedActive) await sleep(2000);
  }
  const answer = await cloudflare<unknown>(
    tokenValue,
    "PUT",
    `/accounts/${accountId}/r2/buckets/${spec.bucket}/lock`,
    { rules: LOCK_RULES[spec.bucket] },
  );
  return {
    token: spec.name,
    bucket: spec.bucket,
    verifiedActive,
    status: answer.status,
    code: answer.errors[0]?.code ?? null,
    denied: !answer.success && (answer.status === 401 || answer.status === 403),
    deniedAt: answer.date === null ? new Date().toISOString() : new Date(answer.date).toISOString(),
  };
}

/**
 * Run 6.2: only the lock rules of the four buckets, with the account-wide R2
 * token `mykey-r2-admin` (bucket configuration needs no token administration).
 * Never weakens a live rule; records the rules read back in the evidence file.
 */
export async function provisionLockRules(accountId: string): Promise<void> {
  const bearer = loadR2ApiToken("mykey-r2-admin");
  const previous = readEvidence();
  const buckets: RetentionFixture["buckets"] = [];
  for (const bucket of BUCKETS) {
    const { rules, action } = await ensureLockRules(bearer, accountId, bucket);
    buckets.push({ name: bucket, lockRules: rules });
    console.log(`bucket ${bucket}: lock rules ${action} (${String(rules.length)})`);
  }
  if (previous !== undefined) writeEvidence({ ...previous, buckets });
}

export async function provision(
  accountId: string,
  options: { roll?: string[]; home?: string } = {},
): Promise<void> {
  const home = options.home ?? homedir();
  const roll = options.roll ?? [];
  const unknown = roll.filter((name) => !TOKEN_PLAN.some((spec) => spec.name === name));
  if (unknown.length > 0) throw new Error(`--roll names no planned token: ${unknown.join(", ")}`);
  const bootstrapFile = join(home, ".mykey", "secrets", "cloudflare", "bootstrap-token");
  if (!existsSync(bootstrapFile)) throw new Error("no bootstrap token file");
  const bootstrap = readFileSync(bootstrapFile, "utf8").trim();
  const previous = readEvidence();

  const buckets: RetentionFixture["buckets"] = [];
  const attempts = new Map<string, LockChangeAttempt>(
    (previous?.lockChangeAttempts ?? []).map((attempt) => [attempt.token, attempt]),
  );
  // Written after the buckets and after every attempt, so that a failure half
  // way never loses an observation that cannot be made again without a roll.
  const record = (): void => {
    writeEvidence({
      version: 1,
      accountId,
      provisionedAt: new Date().toISOString(),
      buckets,
      tokens: TOKEN_PLAN.map((spec) => ({
        name: spec.name,
        bucket: spec.bucket ?? null,
        permissionGroup: spec.permissionGroup,
      })),
      lockChangeAttempts: TOKEN_PLAN.flatMap((spec) => {
        const attempt = attempts.get(spec.name);
        return attempt === undefined ? [] : [attempt];
      }),
      ...(previous?.upload === undefined ? {} : { upload: previous.upload }),
      objects: previous?.objects ?? [],
      checkpoints: previous?.checkpoints ?? [],
    });
  };

  for (const bucket of BUCKETS) {
    const state = await ensureBucket(bootstrap, accountId, bucket);
    const { rules, action } = await ensureLockRules(bootstrap, accountId, bucket);
    buckets.push({ name: bucket, lockRules: rules });
    console.log(`bucket ${bucket}: ${state}; lock rules ${action} (${String(rules.length)})`);
  }
  record();

  const groups = must(
    await cloudflare<{ id: string; name: string }[]>(
      bootstrap,
      "GET",
      "/user/tokens/permission_groups",
    ),
    "list permission groups",
  );
  const groupId = (name: string): string => {
    const [match, ...others] = groups.filter((group) => group.name === name);
    if (match === undefined || others.length > 0) {
      throw new Error(`permission group "${name}": not exactly one match`);
    }
    return match.id;
  };

  const existing = await listTokens(bootstrap);
  for (const spec of TOKEN_PLAN) {
    const [found, ...duplicates] = existing.filter((token) => token.name === spec.name);
    if (duplicates.length > 0) throw new Error(`token ${spec.name}: more than one exists`);
    const action = tokenAction({
      name: spec.name,
      exists: found !== undefined,
      fileComplete: found !== undefined && credentialFileComplete(spec, found.id, home),
      roll,
    });
    if (found !== undefined && action === "keep") {
      console.log(`token ${spec.name}: kept (id ${found.id})`);
      continue;
    }
    if (found !== undefined && action === "leave") {
      console.log(
        `token ${spec.name}: exists (id ${found.id}) but its credential file is not here; ` +
          `left alone. Pass --roll ${spec.name} to replace it.`,
      );
      continue;
    }
    let id: string;
    let value: string;
    if (found === undefined) {
      const created = must(
        await cloudflare<{ id: string; value: string }>(bootstrap, "POST", "/user/tokens", {
          name: spec.name,
          policies: tokenPolicies(spec, accountId, groupId(spec.permissionGroup)),
        }),
        `create token ${spec.name}`,
      );
      ({ id, value } = created);
    } else {
      // The value of an existing token cannot be read again; rolling it gives a new one.
      value = must(
        await cloudflare<string>(bootstrap, "PUT", `/user/tokens/${found.id}/value`, {}),
        `roll token ${spec.name}`,
      );
      id = found.id;
    }
    const file = r2CredentialFile(spec.name, home);
    mkdirSync(dirname(file), { recursive: true });
    const stored =
      spec.bucket === undefined
        ? { ...s3CredentialsFor(accountId, id, value), apiToken: value }
        : s3CredentialsFor(accountId, id, value);
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `token ${spec.name}: ${action === "roll" ? "rolled" : "created"} (id ${id}); credentials written`,
    );

    if (spec.bucket !== undefined) {
      const attempt = await attemptLockChange(value, accountId, { ...spec, bucket: spec.bucket });
      attempts.set(spec.name, attempt);
      record();
      console.log(
        `token ${spec.name}: lock change ${attempt.denied ? "denied" : "NOT DENIED"} ` +
          `(HTTP ${String(attempt.status)}, active ${String(attempt.verifiedActive)})`,
      );
    }
  }
  record();

  const notDenied = [...attempts.values()].filter((attempt) => !attempt.denied);
  if (notDenied.length > 0) {
    throw new Error(
      `lock change was not denied for: ${notDenied.map((attempt) => attempt.token).join(", ")}`,
    );
  }
  const unobserved = tokensWithoutAttempt([...attempts.values()]);
  if (unobserved.length > 0) {
    throw new Error(
      `no lock-change attempt is recorded for: ${unobserved.join(", ")}. ` +
        "The attempt needs the token value, so roll them with --roll.",
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valuesOf = (flag: string): string[] =>
    args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));
  const accountId = valuesOf("--account")[0] ?? process.env.MYKEY_R2_ACCOUNT_ID;
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
    console.error(
      "usage: node infra/backup/retention-fixture/provision.ts --account <account id> [--roll <token name>]… | --locks-only",
    );
    process.exit(1);
  }
  const run = args.includes("--locks-only")
    ? provisionLockRules(accountId)
    : provision(accountId, { roll: valuesOf("--roll") });
  run.then(
    () => {
      console.log("provisioned.");
    },
    (error: unknown) => {
      console.error(
        `provision failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exit(1);
    },
  );
}
