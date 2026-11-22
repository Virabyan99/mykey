// Run 9.4 (D-71; FR-1.99, AC-1.53, AC-1.54): the bounded agent experiment, a
// test harness. A real external agent (Claude Code, headless, the version in
// tools/agent-experiment/lock.json) gets one tool, `node /fixture/ask.mjs`,
// which sends a body to the agent runner of Run 9.3. Six scenarios (1, 2, 3, 4,
// 9, 10 of the plan; 5 to 8 are the runner's own fault paths, proven by
// tests/unit/agent/runner.test.ts) each run as a fresh session.
//
// The needles (the environment's six values, exported by the staging owner,
// the machine token and the API key) stay in this process's memory. The sweep
// counts them in: the transcripts, the runner's private log, the argv of every
// process sampled in the runner during the runs, the agent containers' files,
// and staging's journal of the window (countOnHost). Each surface has a control
// that must be found. The transcripts are kept outside the repository.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDotenv } from "@mykey/contracts";
import { countOnHost, loadHosts, registerSecret } from "../harness/staging.ts";
import {
  STAGING_ORIGIN,
  publicRequest,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const SEED = JSON.parse(readFileSync("docs/evidence/session-9/run-9.3-staging.json", "utf8")) as {
  project: { id: string; environment: string; environmentName: string };
  credential: { id: string };
};
const SCENARIOS = JSON.parse(readFileSync("tools/agent-experiment/scenarios.json", "utf8")) as {
  preamble: string;
  scenarios: {
    id: number;
    prompt: string;
    expect: { answers: string[]; machineReads: number | null };
  }[];
};
const LOCK = JSON.parse(readFileSync("tools/agent-experiment/lock.json", "utf8")) as {
  claudeCode: { version: string };
};
const NETWORK = "mykey-agent-exp";
const RUNNER = "mykey-agent-exp-runner";
const AGENT_IMAGE = "mykey-agent-experiment:local";
const RUNNER_IMAGE = "mykey-agent-runner:local";
const TOKEN_FILE = join(homedir(), ".mykey", "secrets", "agent-runner", "machine-token");
const KEY_FILE = join(homedir(), ".mykey", "secrets", "anthropic", "api-key");
const OUT = join(tmpdir(), "mykey-agent-experiment");
const EVIDENCE = "docs/evidence/session-9/run-9.4-experiment.json";
const DISALLOWED = "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent,TodoWrite";

const docker = (args: string[], timeout = 900_000) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};
const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const count = (haystack: string, needles: readonly string[]): number =>
  needles.reduce((sum, needle) => sum + haystack.split(needle).length - 1, 0);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.size < 32 * 1024 * 1024) out.push(path);
  }
  return out;
}

const environmentPath = `/v1/organizations/${ORGANIZATION}/projects/${SEED.project.id}/environments/${SEED.project.environment}`;
let cookie = "";
let values: string[] = [];
let token = "";
let apiKey = "";
const evidence: Record<string, unknown> = { claudeCode: LOCK.claudeCode.version };
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

async function machineReads(from: string, to: string): Promise<number> {
  ({ cookie } = await stagingOwnerSession());
  const answer = await publicRequest(
    "GET",
    `/v1/organizations/${ORGANIZATION}/audit?actorKind=machine&actorId=${SEED.credential.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`,
    { cookie },
  );
  expect(answer.status).toBe(200);
  const items = (json(answer).items ?? []) as { action: string; outcome: string }[];
  return items.filter((i) => i.action.startsWith("machine.") && i.outcome === "success").length;
}

interface Turn {
  scenario: number;
  requester: string;
  sessionId: string | null;
  model: string | null;
  commands: string[];
  answers: { status: string; category: string; correlationId: string }[];
  machineReads: number;
  seconds: number;
  turns: number | null;
  costUsd: number | null;
  final: string;
  /** The model's own safeguards stopped the session before any request (Run 9.4). */
  modelDeclined: boolean;
}
const turns: Turn[] = [];
const transcripts: string[] = [];
const argvSamples: string[] = [];
const agentFiles: string[] = [];

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  token = readFileSync(TOKEN_FILE, "utf8").trim();
  apiKey = readFileSync(KEY_FILE, "utf8").trim();
  registerSecret(token);
  registerSecret(apiKey);
  ({ cookie } = await stagingOwnerSession());
  const exported = await publicRequest("POST", `${environmentPath}/export`, {
    body: { confirmed: true },
    cookie,
  });
  expect(exported.status, "the owner's export of the fixture environment").toBe(200);
  const parsed = parseDotenv(exported.bytes);
  if (!parsed.ok) throw new Error("the export is not a dotenv file");
  values = parsed.entries.map((entry) => entry.value);
  for (const value of values) registerSecret(value);
  expect(values).toHaveLength(6);

  const built = docker([
    "build",
    "--quiet",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `CLAUDE_CODE_VERSION=${LOCK.claudeCode.version}`,
    "-t",
    AGENT_IMAGE,
    "tools/agent-experiment",
  ]);
  expect(built.code, built.err.slice(-400)).toBe(0);
  expect(docker(["image", "inspect", RUNNER_IMAGE]).code, "the runner image of Run 9.3").toBe(0);
  docker(["rm", "-f", RUNNER]);
  docker(["network", "rm", NETWORK]);
  expect(docker(["network", "create", NETWORK]).code).toBe(0);
  const started = docker([
    "run",
    "-d",
    "--name",
    RUNNER,
    "--network",
    NETWORK,
    "--network-alias",
    "runner",
    "-e",
    "RUNNER_HOST=0.0.0.0",
    "-e",
    `RUNNER_API_URL=${STAGING_ORIGIN}`,
    "-e",
    `RUNNER_PROJECT=${SEED.project.id}`,
    "-e",
    `RUNNER_ENVIRONMENT=${SEED.project.environmentName}`,
    "-v",
    `${TOKEN_FILE.replaceAll("\\", "/")}:/run/secrets/machine-token:ro`,
    RUNNER_IMAGE,
  ]);
  expect(started.code, started.err).toBe(0);
}, 1_200_000);

afterAll(() => {
  docker(["rm", "-f", RUNNER]);
  docker(["network", "rm", NETWORK]);
});

describe("the agent experiment (Run 9.4)", () => {
  it("six scenarios with a real agent: every answer is the runner's enum, reads only on ok, and the sweep finds no needle on any surface while every control is found", async () => {
    const startedAt = new Date().toISOString();
    try {
      for (const scenario of SCENARIOS.scenarios) {
        const requester = `s${String(scenario.id)}-${randomUUID().slice(0, 8)}`;
        const prompt = `${SCENARIOS.preamble.replaceAll("REQUESTER", requester)}\n\n${scenario.prompt}`;
        const container = `mykey-agent-exp-s${String(scenario.id)}`;
        docker(["rm", "-f", container]);
        const from = new Date().toISOString();
        const begin = Date.now();
        // The argv of every process in the runner, sampled while the agent runs.
        const sampling = { on: true };
        const sampler = (async () => {
          while (sampling.on) {
            const s = docker(
              [
                "exec",
                RUNNER,
                "sh",
                "-c",
                'for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null; echo; done',
              ],
              10_000,
            );
            argvSamples.push(s.out);
            await new Promise((r) => setTimeout(r, 100));
          }
        })();
        const stdout = await new Promise<string>((resolve) => {
          const child = spawn(
            "docker",
            [
              "run",
              "--name",
              container,
              "--network",
              NETWORK,
              "-v",
              `${KEY_FILE.replaceAll("\\", "/")}:/run/secrets/anthropic-api-key:ro`,
              AGENT_IMAGE,
              "-p",
              prompt,
              "--output-format",
              "stream-json",
              "--verbose",
              "--max-turns",
              "30",
              "--allowedTools",
              "Bash(node /fixture/ask.mjs:*)",
              "--disallowedTools",
              DISALLOWED,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let text = "";
          child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
          const timer = setTimeout(() => child.kill(), 900_000);
          child.on("close", () => {
            clearTimeout(timer);
            resolve(text);
          });
        });
        sampling.on = false;
        await sampler;
        const seconds = Math.round((Date.now() - begin) / 1000);
        const to = new Date().toISOString();
        writeFileSync(join(OUT, `scenario-${String(scenario.id)}.jsonl`), stdout);
        transcripts.push(stdout);
        // The agent container's files (its home and /tmp), copied out and searched.
        const files = join(OUT, `files-${String(scenario.id)}`);
        mkdirSync(files, { recursive: true });
        for (const path of ["/home/node", "/tmp"]) docker(["cp", `${container}:${path}`, files]);
        for (const file of filesUnder(files)) agentFiles.push(readFileSync(file, "latin1"));
        docker(["rm", "-f", container]);

        const turn: Turn = {
          scenario: scenario.id,
          requester,
          sessionId: null,
          model: null,
          commands: [],
          answers: [],
          machineReads: 0,
          seconds,
          turns: null,
          costUsd: null,
          final: "",
          modelDeclined: stdout.includes("safeguards flagged this message"),
        };
        for (const line of stdout.split("\n")) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type === "system" && event.subtype === "init") {
            turn.sessionId = (event.session_id as string | undefined) ?? null;
            turn.model = (event.model as string | undefined) ?? null;
          }
          const content = ((event.message as { content?: unknown } | undefined)?.content ?? []) as {
            type?: string;
            input?: { command?: string };
            content?: unknown;
          }[];
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type === "tool_use" && typeof block.input?.command === "string") {
              turn.commands.push(block.input.command);
            }
            if (block.type === "tool_result") {
              const text =
                typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              for (const match of text.matchAll(/\{[^{}]*"correlationId"[^{}]*\}/g)) {
                try {
                  turn.answers.push(
                    JSON.parse(match[0].replaceAll('\\"', '"')) as Turn["answers"][number],
                  );
                } catch {
                  // not an answer
                }
              }
            }
          }
          if (event.type === "result") {
            turn.final = typeof event.result === "string" ? event.result : "";
            turn.turns = (event.num_turns as number | undefined) ?? null;
            turn.costUsd = (event.total_cost_usd as number | undefined) ?? null;
          }
        }
        turn.machineReads = await machineReads(from, to);
        turns.push(turn);
        record(
          "scenarios",
          turns.map((t) => ({
            scenario: t.scenario,
            requester: t.requester,
            sessionId: t.sessionId,
            model: t.model,
            requests: t.commands.length,
            answers: t.answers.map((a) => `${a.status}/${a.category}`),
            correlationIds: t.answers.map((a) => a.correlationId),
            machineReads: t.machineReads,
            seconds: t.seconds,
            turns: t.turns,
            costUsd: t.costUsd,
            modelDeclined: t.modelDeclined,
          })),
        );
      }

      // What each scenario was expected to show.
      for (const t of turns) {
        const want = SCENARIOS.scenarios.find((s) => s.id === t.scenario)?.expect;
        // A session the model's safeguards stopped sent nothing: recorded as not
        // exercised by the agent, never as a pass. Every other one reached the runner.
        if (t.modelDeclined) {
          expect(t.answers, `scenario ${String(t.scenario)}: declined, so no answer`).toEqual([]);
        } else {
          expect(
            t.answers.length,
            `scenario ${String(t.scenario)}: the runner answered`,
          ).toBeGreaterThan(0);
        }
        for (const a of t.answers) {
          expect(Object.keys(a).sort(), `scenario ${String(t.scenario)}`).toEqual([
            "category",
            "correlationId",
            "status",
          ]);
        }
        const oks = t.answers.filter((a) => a.category === "ok").length;
        // Reads happen on ok only: the boundary.
        expect(t.machineReads, `scenario ${String(t.scenario)}: reads only on ok`).toBe(oks);
        if (want?.machineReads !== null && want?.machineReads !== undefined) {
          record(`expected-${String(t.scenario)}`, {
            answersExpected: want.answers,
            readsExpected: want.machineReads,
            matched:
              t.machineReads === want.machineReads &&
              t.answers.every((a) => want.answers.includes(a.category)),
          });
        }
      }

      // The sweep. Controls: each surface holds a string that must be there.
      const needles = [...values, token, apiKey];
      const transcriptText = transcripts.join("\n");
      const runnerLog = docker(["exec", RUNNER, "cat", "/var/log/agent-runner/runner.log"]).out;
      const allCorrelations = turns.flatMap((t) => t.answers.map((a) => a.correlationId));
      const sweep = {
        transcripts: {
          needles: count(transcriptText, needles),
          control: allCorrelations.every((id) => transcriptText.includes(id)),
        },
        runnerLog: {
          needles: count(runnerLog, needles),
          control: allCorrelations.every((id) => runnerLog.includes(id)),
        },
        processArgv: {
          needles: count(argvSamples.join("\n"), needles),
          samples: argvSamples.length,
          control: argvSamples.join("\n").includes("/runner/runner.ts"),
        },
        agentFiles: {
          needles: count(agentFiles.join("\n"), needles),
          files: agentFiles.length,
          control: agentFiles.some((text) => text.includes("ask.mjs")),
        },
        runnerDiff: docker(["diff", RUNNER])
          .out.split("\n")
          .filter((line) => line.trim() !== "").length,
      };
      record("sweep", sweep);

      // Staging's journal of the window, searched on the host (only counts return).
      const journal = await countOnHost(
        loadHosts().staging,
        `journalctl --since '${startedAt.replace("T", " ").slice(0, 19)}' -o cat`,
        needles,
        ["/v1/machine/"],
      );
      record("journal", journal);

      expect(sweep.transcripts).toMatchObject({ needles: 0, control: true });
      expect(sweep.runnerLog).toMatchObject({ needles: 0, control: true });
      expect(sweep.processArgv).toMatchObject({ needles: 0, control: true });
      expect(sweep.agentFiles).toMatchObject({ needles: 0, control: true });
      expect(journal.found).toBe(0);
    } finally {
      // Step 4: the experiment's token is revoked.
      ({ cookie } = await stagingOwnerSession());
      const revoked = await publicRequest(
        "POST",
        `${environmentPath}/credentials/${SEED.credential.id}/revoke`,
        { body: { confirmed: true }, cookie, headers: { "idempotency-key": randomUUID() } },
      );
      record("revoked", revoked.status);
    }
  }, 7_200_000);
});
