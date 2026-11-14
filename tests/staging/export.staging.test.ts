// Run 4.9 Task D: export on staging, through the public name as the staging
// owner. A new project `s4-export-<8 hex>` holds three environments:
// `development` (the edge's headers, the round trip's source), `copy` (the
// round trip's target) and `full` (the measurement of P-62: eight imports of
// 125 entries of 7 KiB build 1,000 names and about 7 MiB, then three exports
// against the 60-second ceiling). Projects cannot be deleted: the ids are in
// the run note. Values are synthetic and never printed; digests and lengths
// are compared. Evidence (ids, timings) in run-4.9-staging.json.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseDotenv } from "@mykey/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const EXPORT_CEILING_MS = 60_000;

let cookie: string;
let projectPath: string;
const environments: Record<"development" | "copy" | "full", string> = {
  development: "",
  copy: "",
  full: "",
};

const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-4/run-4.9-staging.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const codeOf = (answer: PublicAnswer): string | undefined =>
  answer.headers.get("content-type")?.startsWith("application/json") === true
    ? (json(answer).error as { code?: string } | undefined)?.code
    : undefined;
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const envPath = (env: keyof typeof environments): string =>
  `${projectPath}/environments/${environments[env]}`;

function send(method: string, path: string, init: { body?: unknown; text?: string | Uint8Array }) {
  return publicRequest(method, path, {
    ...init,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

async function waitActive(environmentId: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const list = (json(listed).environments ?? []) as { id: string; state: string }[];
    const state = list.find((e) => e.id === environmentId)?.state;
    if (state === "active") return;
    if (Date.now() > deadline) throw new Error(`environment stayed ${String(state)}`);
    await sleep(3000);
  }
}

/** A fresh session (the export is a sensitive start: TOTP within ten minutes). */
async function exportOf(
  env: keyof typeof environments,
): Promise<{ answer: PublicAnswer; ms: number }> {
  ({ cookie } = await stagingOwnerSession());
  const started = performance.now();
  const answer = await publicRequest("POST", `${envPath(env)}/export`, {
    body: { confirmed: true },
    cookie,
    headers: { "accept-encoding": "gzip, br" },
  });
  return { answer, ms: performance.now() - started };
}

/** Preview and apply a dotenv file; resumes while the import answers awaiting_input. */
async function importFile(
  env: keyof typeof environments,
  text: Buffer,
): Promise<{ state: string; waits: number; ms: number; outcomes: string[] }> {
  const started = performance.now();
  const preview = await publicRequest("POST", `${envPath(env)}/import/preview`, { text, cookie });
  expect(preview.status, `preview ${codeOf(preview) ?? ""}`).toBe(200);
  expect(json(preview).applicable).toBe(true);
  let answer = await send(
    "POST",
    `${envPath(env)}/import/${String(json(preview).previewId)}/apply`,
    {
      text,
    },
  );
  let waits = 0;
  while (answer.status === 202) {
    expect(json(answer).state).toBe("awaiting_input");
    waits += 1;
    expect(waits, "resumes").toBeLessThan(10);
    answer = await publicRequest(
      "POST",
      `${envPath(env)}/import-operations/${String(json(answer).operationId)}/resume`,
      { text, cookie },
    );
  }
  expect(answer.status, `apply ${codeOf(answer) ?? ""}`).toBe(200);
  const entries = (json(answer).result as { entries: { outcome: string }[] }).entries;
  return {
    state: String(json(answer).state),
    waits,
    ms: performance.now() - started,
    outcomes: entries.map((entry) => entry.outcome),
  };
}

const AWKWARD: Record<string, string> = {
  EMPTY: "",
  MULTILINE: "line one\nline two\r\nline three\n",
  DOUBLE: 'say "hello" and "bye"',
  SINGLE: "it's 'quoted' too",
  DOLLAR: "$HOME ${PATH} $ $$",
  HASH: "# not a comment # either",
  EQUALS: "a=b==c=",
  BACKSLASH: "C:\\path\\to\\file \\n is not a newline \\",
  SPACES: "   leading and trailing   ",
  TABS: "\ta\tb\t",
  FOUR_BYTE: "😀 𝄞 four-byte characters",
  LARGEST: "x".repeat(65_536),
};

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s4-export-${randomBytes(4).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
    body: { name },
  });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}`;
  environments.development = result.developmentEnvironmentId;
  for (const env of ["copy", "full"] as const) {
    const made = await send("POST", `${projectPath}/environments`, { body: { name: env } });
    expect(made.status, env).toBe(201);
    environments[env] = (json(made).result as { environmentId: string }).environmentId;
  }
  record("project", { name, id: result.projectId, environments });
  for (const id of Object.values(environments)) await waitActive(id);
}, 600_000);

describe("export on staging", () => {
  it("export through the edge: content-length present, content-digest verifies, no content-encoding with Accept-Encoding: gzip, br, cache-control no-store", async () => {
    // Twenty names: the awkward twelve and eight plain ones (the round trip's source).
    const values: Record<string, string> = { ...AWKWARD };
    for (let n = 0; n < 8; n += 1) values[`PLAIN_${String(n)}`] = `synthetic-${randomUUID()}`;
    for (const [name, value] of Object.entries(values)) {
      const answer = await send("POST", `${envPath("development")}/secrets`, {
        body: { name: `RT_${name}`, value },
      });
      expect(answer.status, name).toBe(201);
    }
    expect(Object.keys(values)).toHaveLength(20);
    const { answer } = await exportOf("development");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(answer.headers.get("content-length")).toBe(String(answer.bytes.length));
    expect(answer.headers.get("content-digest")).toBe(
      `sha-256=:${createHash("sha256").update(answer.bytes).digest("base64")}:`,
    );
    expect(answer.headers.get("content-encoding")).toBeNull();
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-disposition")).toBe(
      'attachment; filename="mykey-development.env"',
    );
    const parsed = parseDotenv(answer.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(20);
    for (const entry of parsed.entries) {
      expect(digest(entry.value), entry.name).toBe(digest(values[entry.name.slice(3)] ?? "-"));
    }
    record("edge", {
      bytes: answer.bytes.length,
      contentEncoding: answer.headers.get("content-encoding"),
    });
  }, 300_000);

  it("round trip on staging", async () => {
    const first = await exportOf("development");
    expect(first.answer.status).toBe(200);
    const applied = await importFile("copy", first.answer.bytes);
    expect(applied.state).toBe("succeeded");
    expect(applied.outcomes).toHaveLength(20);
    expect(applied.outcomes.every((outcome) => outcome === "created")).toBe(true);
    const second = await exportOf("copy");
    expect(second.answer.status).toBe(200);
    expect(second.answer.bytes.length).toBe(first.answer.bytes.length);
    expect(digest(second.answer.bytes)).toBe(digest(first.answer.bytes));
    record("roundTrip", { names: 20, bytes: first.answer.bytes.length, digestsEqual: true });
  }, 300_000);

  it("the measurement of P-62: 1,000 names of 7 KiB by eight imports, three exports; the slowest export is under 60 s", async () => {
    const imports: { batch: number; seconds: number; resumes: number; state: string }[] = [];
    for (let batch = 0; batch < 8; batch += 1) {
      const lines: string[] = [];
      for (let n = 0; n < 125; n += 1) {
        const name = `FULL_${String(batch)}_${String(n).padStart(3, "0")}`;
        lines.push(`${name}=${randomBytes(3584).toString("hex")}\n`);
      }
      const result = await importFile("full", Buffer.from(lines.join("")));
      expect(result.state, `batch ${String(batch)}`).toBe("succeeded");
      expect(result.outcomes.every((outcome) => outcome === "created")).toBe(true);
      imports.push({
        batch,
        seconds: Math.round(result.ms / 100) / 10,
        resumes: result.waits,
        state: result.state,
      });
      record("imports", imports);
    }
    const exports: { seconds: number; bytes: number }[] = [];
    let firstDigest: string | null = null;
    for (let round = 0; round < 3; round += 1) {
      const { answer, ms } = await exportOf("full");
      expect(answer.status, `export ${String(round)} ${codeOf(answer) ?? ""}`).toBe(200);
      expect(answer.headers.get("content-digest")).toBe(
        `sha-256=:${createHash("sha256").update(answer.bytes).digest("base64")}:`,
      );
      const lines = answer.bytes
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== "");
      expect(lines).toHaveLength(1000);
      firstDigest ??= digest(answer.bytes);
      expect(digest(answer.bytes)).toBe(firstDigest);
      exports.push({ seconds: Math.round(ms / 100) / 10, bytes: answer.bytes.length });
      record("exports", exports);
    }
    const slowest = Math.max(...exports.map((entry) => entry.seconds)) * 1000;
    record("slowestExportMs", slowest);
    expect(slowest).toBeLessThan(EXPORT_CEILING_MS);
  }, 3_600_000);
});
