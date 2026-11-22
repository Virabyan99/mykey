// Run 6.9 Task B (P-128): staging through the deploy tooling. host-v0.6.0 is
// deployed (staging's conversion to gate v2), rolled back to host-v0.5.9 and
// deployed forward again, each by `host.ts staging deploy --release <dir>`.
// While a deploy runs a poller asks the public name once a second: between the
// gate's close and open it answers quarantined, and never a 5xx of the
// proxy's own for longer than a restart. After each: the running images are
// the release's, the record is v2 open + serving with this build and a report
// hash, and the journey revealed the same digest. Releases are read from
// MYKEY_RELEASE_NEW and MYKEY_RELEASE_PREVIOUS, both required (Session 9).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseSchema, type Release } from "../../infra/release/release-schema.ts";
import { connectStaging, expectSuccess, sshExec, type StagingStack } from "../harness/staging.ts";
import { stagingDatabase } from "../harness/staging-db.ts";
import { STAGING_ORIGIN } from "../harness/staging-owner.ts";

// Session 9: no default. Run 6.9's defaults (host-v0.6.0 over host-v0.5.9) left
// staging on a six-week-old release when the variables were forgotten.
function releaseDir(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must name a release directory (the candidate and the one before it)`);
  }
  return value;
}
const NEW = releaseDir("MYKEY_RELEASE_NEW");
const PREVIOUS = releaseDir("MYKEY_RELEASE_PREVIOUS");
const JOURNEY = join(homedir(), ".mykey", "secrets", "hosts", "staging", "deploy-journey.json");
const ROOT = resolve(import.meta.dirname, "..", "..");
const PROXY_5XX_LIMIT_MS = 120_000;

let staging: StagingStack;
const started = new Date();

beforeAll(async () => {
  for (const dir of [NEW, PREVIOUS]) {
    if (!existsSync(join(dir, "release.json"))) throw new Error(`no release in ${dir}`);
  }
  staging = await connectStaging();
}, 120_000);

afterAll(async () => {
  await (staging as StagingStack | undefined)?.close();
});

const releaseOf = (dir: string): Release =>
  releaseSchema.parse(JSON.parse(readFileSync(join(dir, "release.json"), "utf8")));

interface Sample {
  at: number;
  status: number;
  code: string;
  fromApi: boolean;
}

/** GET /v1/organizations on the public name once a second until stopped. */
function poll(): { stop(): Promise<Sample[]> } {
  const samples: Sample[] = [];
  const flag = { running: true };
  const loop = (async () => {
    while (flag.running) {
      const at = Date.now();
      try {
        const answer = await fetch(`${STAGING_ORIGIN}/v1/organizations`, {
          signal: AbortSignal.timeout(10_000),
        });
        const text = await answer.text();
        let code = "";
        let fromApi = false;
        try {
          const body = JSON.parse(text) as { error?: { code?: string } };
          code = body.error?.code ?? "";
          fromApi = true;
        } catch {
          fromApi = false;
        }
        samples.push({ at, status: answer.status, code, fromApi });
      } catch {
        samples.push({ at, status: 0, code: "unreachable", fromApi: false });
      }
      await new Promise((r) => setTimeout(r, Math.max(0, 1_000 - (Date.now() - at))));
    }
  })();
  return {
    async stop() {
      flag.running = false;
      await loop;
      return samples;
    },
  };
}

function deploy(dir: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["scripts/host.ts", "staging", "deploy", "--release", dir],
      {
        cwd: ROOT,
        env: { ...process.env, MSYS_NO_PATHCONV: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.on("close", (code) => {
      done({ code, output });
    });
  });
}

/** The longest run of answers that did not come from the API (a proxy's 5xx, or none). */
function longestProxyOutage(samples: Sample[]): number {
  let longest = 0;
  let since: number | null = null;
  for (const s of samples) {
    if (!s.fromApi && (s.status === 0 || s.status >= 500)) {
      since ??= s.at;
      longest = Math.max(longest, s.at - since);
    } else {
      since = null;
    }
  }
  return longest;
}

async function running(): Promise<Record<string, string>> {
  const out = expectSuccess(
    await sshExec(
      staging.host,
      "for c in api provisioner; do printf '%s ' $c; docker inspect --format '{{.Image}}' mykey-$c-1; done",
      { sudo: true },
    ),
    "inspecting the containers",
  ).stdout;
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.trim().split(" ") as [string, string]),
  );
}

async function gateRecord(): Promise<Record<string, unknown>> {
  const text = expectSuccess(
    await sshExec(staging.host, "cat /etc/mykey/gate/gate.json", { sudo: true }),
    "reading the gate",
  ).stdout;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("staging through the deploy tooling (P-128)", () => {
  it(
    "host-v0.6.0, back to host-v0.5.9 and forward again: each ends open; quarantined while closed; the same reveal digest",
    async () => {
      const digests: string[] = [];
      for (const [label, dir] of [
        ["deploy", NEW],
        ["rollback", PREVIOUS],
        ["forward again", NEW],
      ] as const) {
        const release = releaseOf(dir);
        const poller = poll();
        const run = await deploy(dir);
        const samples = await poller.stop();
        expect(run.code, `${label}: ${run.output.slice(-2_000)}`).toBe(0);

        expect(
          samples.some((s) => s.status === 503 && s.code === "quarantined"),
          `${label}: quarantined while closed`,
        ).toBe(true);
        expect(longestProxyOutage(samples), `${label}: proxy outage`).toBeLessThan(
          PROXY_5XX_LIMIT_MS,
        );

        const images = await running();
        const listed = Object.fromEntries(release.images.map((i) => [i.name, i.imageId]));
        expect(images, label).toEqual({ api: listed.api, provisioner: listed.provisioner });

        const record = await gateRecord();
        expect(record, label).toMatchObject({
          version: 2,
          state: "open",
          phase: "serving",
          releaseBuild: release.commit.slice(0, 12),
        });
        expect(record.reportSha256, label).toMatch(/^[0-9a-f]{64}$/);

        digests.push((JSON.parse(readFileSync(JOURNEY, "utf8")) as { sha256: string }).sha256);
      }
      expect(new Set(digests).size).toBe(1);

      const db = await stagingDatabase(staging);
      try {
        const rows = await db.pool("maintenance").query<{ action: string; n: string }>(
          `SELECT action, count(*) AS n FROM audit.event
            WHERE action IN ('operator.deploy', 'operator.gate_open') AND occurred_at >= $1
            GROUP BY action ORDER BY action`,
          [started],
        );
        expect(rows.rows.map((r) => [r.action, Number(r.n)])).toEqual([
          ["operator.deploy", 3],
          ["operator.gate_open", 3],
        ]);
      } finally {
        await db.drop();
      }
    },
    4 * 3_600_000,
  );
});
