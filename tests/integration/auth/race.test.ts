// Run 2.3 Task D: elevations racing in two processes (D-19). Each worker is a
// child process with its own pool and its own Better Auth instance; both get
// the same command and start it at the same wall-clock moment. 50 rounds per
// scenario; after every round the tables must agree with the answers.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { codeAt, generateRecoveryCodes, recoveryVerifier, stepAt, type KeyRing } from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../database/setup.ts";
import {
  BASE_URL,
  authFixture,
  enrolledUser,
  tokenOf,
  type AuthFixture,
  type EnrolledUser,
} from "./fixture.ts";

const ROUNDS = 50;
const WORKER = resolve(import.meta.dirname, "race-worker.ts");

interface Answer {
  id: number;
  ok: boolean;
  reason: string | null;
}

class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly waiting = new Map<number, (answer: Answer) => void>();
  private ready: Promise<void>;

  constructor(init: unknown) {
    this.child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout });
    let markReady: () => void = () => undefined;
    this.ready = new Promise((resolveReady) => {
      markReady = resolveReady;
    });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line) as Answer & { ready?: boolean };
      if (message.ready === true) {
        markReady();
        return;
      }
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
    this.child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.child.stdin.write(`${JSON.stringify({ init })}\n`);
  }

  async started(): Promise<void> {
    await this.ready;
  }

  send(command: { id: number; at: number; [field: string]: unknown }): Promise<Answer> {
    return new Promise((resolveAnswer) => {
      this.waiting.set(command.id, resolveAnswer);
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolveExit) => this.child.once("exit", resolveExit));
    this.child.stdin.write(`${JSON.stringify({ exit: true })}\n`);
    const timer = setTimeout(() => this.child.kill(), 10_000);
    await exited;
    clearTimeout(timer);
  }
}

const wireRing = (ring: KeyRing) => ({
  current: ring.current,
  keys: Object.fromEntries(
    Object.entries(ring.keys).map(([id, key]) => [id, Buffer.from(key).toString("base64")]),
  ),
});

let fixture: AuthFixture;
let workers: [Worker, Worker];
let nextId = 0;

beforeAll(async () => {
  fixture = await authFixture();
  const init = {
    target: fixture.db.targets.api_runtime,
    baseURL: BASE_URL,
    keys: {
      cookieSecret: fixture.keys.cookieSecret,
      sessionLookup: wireRing(fixture.keys.sessionLookup),
      seedEncryption: wireRing(fixture.keys.seedEncryption),
      recoveryVerifier: wireRing(fixture.keys.recoveryVerifier),
    },
  };
  workers = [new Worker(init), new Worker(init)];
  await Promise.all(workers.map((worker) => worker.started()));
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.stop()));
  await fixture.close();
});

/** Both workers run their command starting at the same moment. */
async function race(
  first: { op: "totp" | "recovery"; token: string; code: string; now: number },
  second: { op: "totp" | "recovery"; token: string; code: string; now: number },
): Promise<Answer[]> {
  const at = Date.now() + 60;
  return Promise.all([
    workers[0].send({ id: nextId++, at, ...first }),
    workers[1].send({ id: nextId++, at, ...second }),
  ]);
}

interface Counts {
  mfaSessions: number;
  usedSteps: number;
  consumedCodes: number;
  /** mfa_complete sessions with neither a TOTP time nor a consumed code. */
  unexplained: number;
}

async function counts(user: EnrolledUser): Promise<Counts> {
  const rows = await run<{ mfa: string; steps: string; codes: string; unexplained: string }>(
    fixture.pool,
    `SELECT
       (SELECT count(*) FROM auth.session WHERE user_id = $1 AND phase = 'mfa_complete') AS mfa,
       (SELECT count(*) FROM auth.totp_step_used s JOIN auth.totp_enrollment e ON e.id = s.enrollment_id
         WHERE e.user_id = $1) AS steps,
       (SELECT count(*) FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id
         WHERE e.user_id = $1 AND r.consumed_at IS NOT NULL AND r.consumed_by_session IS NOT NULL) AS codes,
       (SELECT count(*) FROM auth.session s WHERE s.user_id = $1 AND s.phase = 'mfa_complete'
          AND s.totp_verified_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM auth.recovery_code r WHERE r.consumed_by_session = s.id)) AS unexplained`,
    [user.id],
  );
  const row = rows[0];
  return {
    mfaSessions: Number(row?.mfa),
    usedSteps: Number(row?.steps),
    consumedCodes: Number(row?.codes),
    unexplained: Number(row?.unexplained),
  };
}

const okCount = (answers: Answer[]): number => answers.filter((answer) => answer.ok).length;

/** A time whose step no earlier round used: rounds walk back in time 90 s apart. */
const roundTime = (scenario: number, round: number): Date =>
  new Date(Date.now() - (scenario * 200 + round + 1) * 90_000);

describe("racing elevations", () => {
  it("the same code on the same pending session: exactly one succeeds", async () => {
    const user = await enrolledUser(fixture);
    for (let round = 0; round < ROUNDS; round += 1) {
      const before = await counts(user);
      const token = tokenOf(await fixture.signIn(user));
      const now = roundTime(1, round);
      const command = {
        op: "totp" as const,
        token,
        code: codeAt(user.seed, stepAt(now)),
        now: now.getTime(),
      };
      const answers = await race(command, command);
      expect(
        answers.filter((a) => a.reason?.startsWith("error") === true),
        `round ${round}`,
      ).toEqual([]);
      expect(okCount(answers), `round ${round}: ${JSON.stringify(answers)}`).toBe(1);
      const after = await counts(user);
      expect(after.mfaSessions - before.mfaSessions, `round ${round}`).toBe(1);
      expect(after.usedSteps - before.usedSteps, `round ${round}`).toBe(1);
      expect(after.unexplained).toBe(0);
    }
  }, 600_000);

  it("the same code on two pending sessions of one user: one succeeds, the other is a replay", async () => {
    const user = await enrolledUser(fixture);
    for (let round = 0; round < ROUNDS; round += 1) {
      const before = await counts(user);
      const tokens = [tokenOf(await fixture.signIn(user)), tokenOf(await fixture.signIn(user))];
      const now = roundTime(2, round);
      const code = codeAt(user.seed, stepAt(now));
      const answers = await race(
        { op: "totp", token: tokens[0] ?? "", code, now: now.getTime() },
        { op: "totp", token: tokens[1] ?? "", code, now: now.getTime() },
      );
      expect(okCount(answers), `round ${round}: ${JSON.stringify(answers)}`).toBe(1);
      expect(answers.find((a) => !a.ok)?.reason, `round ${round}`).toBe("replayed");
      const after = await counts(user);
      expect(after.mfaSessions - before.mfaSessions, `round ${round}`).toBe(1);
      expect(after.usedSteps - before.usedSteps, `round ${round}`).toBe(1);
      expect(after.unexplained).toBe(0);
    }
  }, 600_000);

  it("one recovery code used twice at once: exactly one succeeds", async () => {
    const user = await enrolledUser(fixture);
    const enrollment = await run<{ id: string }>(
      fixture.pool,
      "SELECT id FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
      [user.id],
    );
    const enrollmentId = enrollment[0]?.id ?? "";
    const ring = fixture.keys.recoveryVerifier;
    for (let round = 0; round < ROUNDS; round += 1) {
      const before = await counts(user);
      // One fresh code per round, stored as the module stores it.
      const code = generateRecoveryCodes()[0] ?? "";
      await run(
        fixture.pool,
        "INSERT INTO auth.recovery_code (id, enrollment_id, verifier, key_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), enrollmentId, recoveryVerifier(ring, enrollmentId, code), ring.current],
      );
      const tokens = [tokenOf(await fixture.signIn(user)), tokenOf(await fixture.signIn(user))];
      const now = Date.now();
      const answers = await race(
        { op: "recovery", token: tokens[0] ?? "", code, now },
        { op: "recovery", token: tokens[1] ?? "", code, now },
      );
      expect(okCount(answers), `round ${round}: ${JSON.stringify(answers)}`).toBe(1);
      expect(answers.find((a) => !a.ok)?.reason, `round ${round}`).toBe("invalid");
      const after = await counts(user);
      expect(after.mfaSessions - before.mfaSessions, `round ${round}`).toBe(1);
      expect(after.consumedCodes - before.consumedCodes, `round ${round}`).toBe(1);
      expect(after.unexplained).toBe(0);
    }
  }, 600_000);
});
