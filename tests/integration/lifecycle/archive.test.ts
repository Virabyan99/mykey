// Run 5.3 Task B (P-91, FR-1.17, D-41): an archive closes first, revokes and
// verifies every credential of its scope, then says archived. From `revoking`
// on, no change and no machine access is admitted; humans keep their reads
// (AC-1.11). Whatever stops the drive leaves the operation executing; the
// tick's driver finishes it. Tokens are compared by status codes only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { listUnresolved } from "@mykey/db";
import { machineName } from "@mykey/openbao";
import { runOps } from "@mykey/ops";
import type { EnvironmentId } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  accessorAnswer,
  accessorsOf,
  archive,
  archiveDriver,
  issueAt,
  newEnvironment,
  newProject,
  resourceState,
  successRows,
  type Place,
} from "../../harness/lifecycle-fixture.ts";
import { machineFetch, machinePath, type MachineAnswer } from "../../harness/machine.ts";
import type { Answer } from "../../harness/secrets-fixture.ts";
import { readAuditLog } from "../../harness/stack.ts";

let f: CredentialsFixture;
/** TLS records of the issuer's AppRole login request (headers and body); the next record is the revoke's, whose answer is the first one lost. */
const LOGIN_RECORDS = 2;
let driver: ReturnType<typeof archiveDriver>;

beforeAll(async () => {
  f = await createCredentialsFixture();
  driver = archiveDriver(f);
}, 600_000);

afterAll(async () => {
  await driver.close();
  await f.close();
});

afterEach(() => {
  f.setFaults(null);
  f.relay.clear();
});

const credentialStates = async (environmentId: string): Promise<string[]> =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE environment_id = $1 ORDER BY state",
      [environmentId],
    )
  ).rows.map((row) => row.state);

const operation = async (id: string) =>
  (
    await f.api.superuser.query<{ state: string; result: Record<string, unknown> | null }>(
      "SELECT state, result FROM app.operation WHERE id = $1",
      [id],
    )
  ).rows[0];

/** Holds the archive's drive at `point` until released. */
function holdAt(point: string): { reached: Promise<string>; release(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedWith!: (operationId: string) => void;
  const reached = new Promise<string>((resolve) => {
    reachedWith = resolve;
  });
  f.setFaults(async (at, operationId) => {
    if (at !== point) return;
    reachedWith(operationId);
    await held;
  });
  return { reached, release };
}

async function placeWithCredentials(count: number): Promise<{ place: Place; tokens: string[] }> {
  const place = await newProject(f);
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) tokens.push((await issueAt(f, place)).token);
  return { place, tokens };
}

describe("environment archive", () => {
  it("200 archived; every credential revoked; every accessor answers 400; the policy, the token role and the stored secrets are still there", async () => {
    const { place } = await placeWithCredentials(3);
    const other = await newEnvironment(f, place);
    await issueAt(f, other);
    const secret = await f.send("POST", `${place.path}/secrets`, {
      body: { name: "KEPT", value: "synthetic" },
    });
    expect(secret.status).toBe(201);
    const answer = await archive(f, place.path);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "archived", environments: 1, credentialsRevoked: 3 },
    });
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
    expect(await credentialStates(place.environmentId)).toEqual(["revoked", "revoked", "revoked"]);
    for (const accessor of await accessorsOf(f, place.environmentId)) {
      expect(await accessorAnswer(f, accessor)).toBe(400);
    }
    // The other environment of the project is untouched.
    expect(await credentialStates(other.environmentId)).toEqual(["active"]);
    // Policy, token role and values stay.
    const name = machineName(place.environmentId as EnvironmentId);
    for (const path of [`sys/policies/acl/${name}`, `auth/token/roles/${name}`]) {
      const read = await baoAnswer(f.stack, f.stack.bao.rootToken, "GET", path, {
        namespace: f.fx.namespace,
      });
      expect(read.status, path).toBe(200);
    }
    const reveal = await f.send("POST", `${place.path}/secrets/KEPT/reveal`, {
      body: {},
      key: null,
    });
    expect(reveal.status).toBe(200);
  });

  it("from revoking on, nothing is admitted; humans keep their reads; another environment works", async () => {
    const { place } = await placeWithCredentials(1);
    const other = await newEnvironment(f, place);
    for (const where of [place, other]) {
      const made = await f.send("POST", `${where.path}/secrets`, {
        body: { name: "R", value: "v" },
      });
      expect(made.status).toBe(201);
    }
    const hold = holdAt("archive_after_marker");
    const pending = archive(f, place.path);
    await hold.reached;
    try {
      expect((await resourceState(f, "environment", place.environmentId)).state).toBe("revoking");
      const write = await f.send("POST", `${place.path}/secrets`, {
        body: { name: "W", value: "v" },
      });
      expect([write.status, write.code]).toEqual([409, "state_conflict"]);
      await f.freshen();
      const issue = await f.send("POST", `${place.path}/credentials`, { body: { name: "x" } });
      expect([issue.status, issue.code]).toEqual([409, "state_conflict"]);
      const preview = await f.send("POST", `${place.path}/import/preview`, {
        text: "A=1\n",
        key: null,
      });
      expect([preview.status, preview.code]).toEqual([409, "state_conflict"]);
      const reveal = await f.send("POST", `${place.path}/secrets/R/reveal`, {
        body: {},
        key: null,
      });
      expect(reveal.status).toBe(200);
      const otherWrite = await f.send("POST", `${other.path}/secrets`, {
        body: { name: "W", value: "v" },
      });
      expect(otherWrite.status).toBe(201);
    } finally {
      hold.release();
    }
    expect((await pending).status).toBe(200);
  });

  // Gate review, Important 2: the archive takes no environment lock (Ruling 46), so
  // a machine read admitted before the archive's admission is checked again when
  // it commits; from revoking on it answers nothing.
  it("a machine read admitted before the archive's admission does not answer after it: 403 action_denied, no entries, no machine.resolve row", async () => {
    const { place, tokens } = await placeWithCredentials(1);
    const made = await f.send("POST", `${place.path}/secrets`, {
      body: { name: "READ", value: "synthetic" },
    });
    expect(made.status).toBe(201);
    const envName = (
      await f.api.superuser.query<{ name: string }>(
        "SELECT name FROM app.environment WHERE id = $1",
        [place.environmentId],
      )
    ).rows[0]!.name;
    let pending: Promise<Answer> | null = null;
    let admitted!: () => void;
    const archiveAdmitted = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let readDone!: () => void;
    const readFinished = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    f.setFaults(async (point) => {
      if (point === "after_backend_read" && pending === null) {
        // The read has its values and still holds the environment's lock.
        pending = archive(f, place.path);
        await archiveAdmitted;
      } else if (point === "archive_after_marker") {
        admitted();
        await readFinished;
      }
    });
    let answer: MachineAnswer;
    try {
      answer = await machineFetch(
        { port: f.api.port, ca: readFileSync(f.stack.api.certAuthorityPath) },
        "POST",
        machinePath(place.projectId, envName, "resolve"),
        { token: tokens[0]! },
      );
    } finally {
      readDone();
    }
    f.setFaults(null);
    expect(pending).not.toBeNull();
    const archived = await pending!;
    expect([answer.status, answer.code]).toEqual([403, "action_denied"]);
    expect(answer.body.entries).toBeUndefined();
    const rows = await f.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'machine.resolve' AND request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(rows.rowCount).toBe(0);
    expect(archived.status).toBe(200);
  });

  it("a wrong confirmation → 422; editorA is denied; ownerB gets the hidden 404", async () => {
    const place = await newProject(f);
    const wrong = await archive(f, place.path, { body: { confirmed: false } });
    expect(wrong.status).toBe(422);
    // editorA's grants are on the fixture's projects; a refused request changes nothing there.
    const denied = await archive(f, f.env("env1a").path, { user: "editorA" });
    expect([denied.status, denied.code]).toEqual([403, "action_denied"]);
    expect((await resourceState(f, "environment", f.env("env1a").environmentId)).state).toBe(
      "active",
    );
    const hidden = await archive(f, f.env("env1a").path, { user: "ownerB" });
    expect([hidden.status, hidden.code]).toEqual([404, "not_found"]);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("active");
  });

  it("replay after success → 200 with the same result and no further revoke-accessor in OpenBao's audit device", async () => {
    const { place } = await placeWithCredentials(2);
    const key = randomUUID();
    const first = await archive(f, place.path, { key });
    expect(first.status).toBe(200);
    const count = async () =>
      (await readAuditLog(f.stack)).filter(
        (entry) =>
          entry.type === "request" &&
          entry.path === "auth/token/revoke-accessor" &&
          entry.headers["x-mykey-operation-id"]?.[0] === first.body.operationId,
      ).length;
    const before = await count();
    expect(before).toBe(2);
    const again = await archive(f, place.path, { key });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await count()).toBe(before);
    const second = await archive(f, place.path);
    expect([second.status, second.code]).toEqual([409, "state_conflict"]);
  });

  it("an environment whose slot is held → 409 state_conflict with the holder's operation id", async () => {
    const place = await newProject(f);
    const made = await f.send("POST", `${place.path}/secrets`, { body: { name: "S", value: "v" } });
    expect(made.status).toBe(201);
    const writer = holdAt("after_dispatch_marker");
    const write = f.send("PATCH", `${place.path}/secrets/S`, {
      body: {
        value: "w",
        expectedVersion: 1,
        expectedStateTag: (made.body.result as { stateTag: string }).stateTag,
      },
    });
    const holder = await writer.reached;
    let answer;
    try {
      f.setFaults(null);
      answer = await archive(f, place.path);
    } finally {
      writer.release();
    }
    await write;
    expect([answer.status, answer.code]).toEqual([409, "state_conflict"]);
    expect(answer.operationId).toBe(holder);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("active");
  });

  it("the lock is busy (an issuance holds it): 202, the environment revoking; the issuance withdraws; the tick's driver → archived and the status route says succeeded", async () => {
    const { place } = await placeWithCredentials(1);
    const issuer = holdAt("after_marker");
    await f.freshen();
    const issuing = f.send("POST", `${place.path}/credentials`, { body: { name: "late" } });
    await issuer.reached;
    let answer;
    try {
      f.setFaults(null);
      answer = await archive(f, place.path);
    } finally {
      issuer.release();
    }
    expect(answer.status).toBe(202);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("revoking");
    const late = await issuing;
    expect([late.status, late.code]).toEqual([409, "state_conflict"]);
    const driven = await driver.run(0);
    expect(driven.archived).toContain(answer.body.operationId);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
    expect(await credentialStates(place.environmentId)).toEqual(["revoked", "revoked"]);
    const status = await f.send("GET", `/v1/operations/${String(answer.body.operationId)}`, {
      key: null,
    });
    expect(status.body.state).toBe("succeeded");
  });

  it("a revocation cannot be proven (OpenBao's answers are lost after the issuer login): 202; then the tick's driver finishes it; one success audit row", async () => {
    const { place } = await placeWithCredentials(2);
    f.setFaults((point) => {
      // The login's request passes and is answered; from the next request on nothing comes back.
      if (point === "archive_after_marker") f.relay.dropAfter(LOGIN_RECORDS + 1);
    });
    const answer = await archive(f, place.path);
    f.setFaults(null);
    f.relay.clear();
    expect(answer.status).toBe(202);
    // A revocation was sent: the drive got past the login.
    const sent = (await readAuditLog(f.stack)).filter(
      (entry) =>
        entry.type === "request" &&
        entry.path === "auth/token/revoke-accessor" &&
        entry.headers["x-mykey-operation-id"]?.[0] === answer.body.operationId,
    );
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(await credentialStates(place.environmentId)).toEqual(["revoking", "revoking"]);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("revoking");
    const driven = await driver.run(0);
    expect(driven.archived).toContain(answer.body.operationId);
    expect(await credentialStates(place.environmentId)).toEqual(["revoked", "revoked"]);
    expect(await successRows(f, answer.body.operationId as string)).toBe(1);
    expect((await driver.run(0)).archived).not.toContain(answer.body.operationId);
    expect(await successRows(f, answer.body.operationId as string)).toBe(1);
  }, 120_000);

  it("a driveArchive throw answers 503 with the operation id; the same key replays to the finished archive", async () => {
    const { place } = await placeWithCredentials(1);
    const key = randomUUID();
    f.setFaults((point) => {
      if (point === "archive_before_finish_commit") throw new Error("seeded: the drive throws");
    });
    const answer = await archive(f, place.path, { key });
    f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    // The admission is committed: the answer names the operation the owner can look up.
    const marked = await resourceState(f, "environment", place.environmentId);
    expect(marked.state).toBe("revoking");
    expect(answer.operationId).toBe(marked.archive_operation_id);
    expect((await operation(answer.operationId!))?.state).toBe("executing");
    const driven = await driver.run(0);
    expect(driven.archived).toContain(answer.operationId);
    const replay = await archive(f, place.path, { key });
    expect(replay.status).toBe(200);
    expect(replay.body.operationId).toBe(answer.operationId);
    expect(await successRows(f, answer.operationId!)).toBe(1);
  }, 120_000);

  it("a credential in needs_review blocks the end, not the closing; after reconcile-credentials with exclusion the next tick says archived", async () => {
    const { place } = await placeWithCredentials(1);
    f.setFaults((point) => {
      if (point === "after_marker") throw new Error("fault");
    });
    await f.freshen();
    const unresolved = await f.send("POST", `${place.path}/credentials`, { body: { name: "u" } });
    f.setFaults(null);
    expect(unresolved.code).toBe("outcome_unknown");
    const answer = await archive(f, place.path);
    expect(answer.status).toBe(202);
    const id = answer.body.operationId as string;
    expect(await credentialStates(place.environmentId)).toEqual(["needs_review", "revoked"]);
    expect((await driver.run(0)).waiting).toContain(id);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("revoking");
    await f.api.superuser.query(
      "UPDATE app.operation SET heartbeat_at = now() - interval '121 seconds' WHERE id = $1",
      [id],
    );
    const unresolvedOps = await listUnresolved(f.api.pool, f.tenants.a.organizationId as never);
    expect(unresolvedOps.some((entry) => entry.id === id)).toBe(true);
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.end();
    const code = await runOps(
      [
        "reconcile-credentials",
        "--environment",
        place.environmentId,
        "--executors-excluded",
        "yes",
      ],
      {
        stdin,
        stdout,
        stderr: new PassThrough(),
        env: {
          database: f.api.database.targets.maintenance,
          openBao: { target: f.stack.bao, rootToken: f.stack.bao.rootToken },
        },
      },
    );
    expect(code).toBe(0);
    expect((await driver.run(120)).archived).toContain(id);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
    expect((await operation(id))?.state).toBe("succeeded");
  });
});

describe("project archive", () => {
  it("over an active environment, one archived on its own before, one in needs_review: all credentials revoked; only the active one becomes archived with origin project", async () => {
    const { place } = await placeWithCredentials(1);
    const own = await newEnvironment(f, place);
    await issueAt(f, own);
    const ownArchive = await archive(f, own.path);
    expect(ownArchive.status).toBe(200);
    const review = await newEnvironment(f, place);
    await issueAt(f, review);
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [review.environmentId],
    );
    const answer = await archive(f, place.projectPath);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body.result).toMatchObject({
      state: "archived",
      environments: 3,
      credentialsRevoked: 2,
    });
    const id = answer.body.operationId as string;
    expect(await resourceState(f, "project", place.projectId)).toMatchObject({
      state: "archived",
      archive_operation_id: id,
    });
    expect(await resourceState(f, "environment", place.environmentId)).toEqual({
      state: "archived",
      archive_origin: "project",
      archive_operation_id: id,
    });
    expect(await resourceState(f, "environment", own.environmentId)).toEqual({
      state: "archived",
      archive_origin: "self",
      archive_operation_id: ownArchive.body.operationId,
    });
    expect((await resourceState(f, "environment", review.environmentId)).state).toBe(
      "needs_review",
    );
    for (const env of [place, own, review]) {
      expect(await credentialStates(env.environmentId)).toEqual(["revoked"]);
    }
  });

  it("a project with a pending environment → 409 state_conflict", async () => {
    const place = await newProject(f);
    await f.api.superuser.query(
      `INSERT INTO app.environment (id, organization_id, project_id, name, state)
       VALUES ($1, $2, $3, 'waiting', 'pending')`,
      [randomUUID(), f.tenants.a.organizationId, place.projectId],
    );
    const answer = await archive(f, place.projectPath);
    expect([answer.status, answer.code]).toEqual([409, "state_conflict"]);
    expect((await resourceState(f, "project", place.projectId)).state).toBe("active");
  });
});
