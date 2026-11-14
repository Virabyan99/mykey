// The import under crashes (Run 4.7 Task C, AC-1.39): a real API process
// killed between two entries, inside an entry after the send, and after the
// last entry before the parent is finished. Each time the sweep leaves a
// truthful parent, a resume or the operator finishes it, and every entry is
// one backend change at most.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectIndexMatchesBackend, type Answer } from "../../harness/secrets-fixture.ts";
import { faultFixture, synthetic, unique, type FaultFixture } from "./fixture.ts";

let ff: FaultFixture;

beforeAll(async () => {
  ff = await faultFixture();
}, 600_000);

afterAll(async () => {
  await ff.close();
}, 300_000);

const values: string[] = [];
const fileOf = (names: readonly string[]): string =>
  names
    .map((name) => {
      const value = synthetic();
      values.push(value);
      return `${name}=${value}\n`;
    })
    .join("");

/** No value of any file in the output of the process that died (rule 2). */
const noValueInOutput = (): boolean => {
  const output = ff.f.second?.output() ?? "";
  return values.every((value) => !output.includes(value));
};

async function preview(text: string): Promise<string> {
  const answer = await ff.f.send("POST", `${ff.f.env("env1a").path}/import/preview`, {
    text,
    key: null,
  });
  expect(answer.status).toBe(200);
  return answer.body.previewId as string;
}

/** Sends the apply to the child process, which dies on its fault: no answer. */
async function applyOnChild(previewId: string, text: string): Promise<void> {
  const answered = await ff.f
    .send("POST", `${ff.f.env("env1a").path}/import/${previewId}/apply`, { text, to: "second" })
    .then(
      (answer: Answer) => answer.status,
      () => null,
    );
  expect(answered, "the process died before answering").toBeNull();
}

async function parentOf(previewId: string): Promise<string> {
  const result = await ff.f.api.superuser.query<{ id: string }>(
    "SELECT claimed_by_operation_id AS id FROM app.import_preview WHERE id = $1",
    [previewId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("the preview was not claimed");
  return id;
}

async function children(parentId: string) {
  const result = await ff.f.api.superuser.query<{ id: string; state: string }>(
    "SELECT id, state FROM app.operation WHERE parent_operation_id = $1 ORDER BY created_at",
    [parentId],
  );
  return result.rows;
}

async function outcomes(parentId: string) {
  const result = await ff.f.api.superuser.query<{ outcome: string | null }>(
    "SELECT outcome FROM app.import_entry WHERE parent_operation_id = $1 ORDER BY ordinal",
    [parentId],
  );
  return result.rows.map((row) => row.outcome);
}

function resume(parentId: string, text: string): Promise<Answer> {
  return ff.f.send("POST", `${ff.f.env("env1a").path}/import-operations/${parentId}/resume`, {
    text,
    key: null,
  });
}

describe("an import in a process that dies", () => {
  it("the process dies between two entries → after the sweep the parent is awaiting_input; resume finishes; one change per entry", async () => {
    const names = [unique(), unique(), unique()];
    const text = fileOf(names);
    const previewId = await preview(text);
    await ff.child({ point: "between_entries", action: "crash" });
    await applyOnChild(previewId, text);
    const parentId = await parentOf(previewId);
    expect((await ff.operation(parentId))?.state).toBe("executing");
    expect(await outcomes(parentId)).toEqual(["created", null, null]);

    const swept = await ff.sweepNow();
    expect(swept.awaitingInput).toContain(parentId);
    expect((await ff.operation(parentId))?.state).toBe("awaiting_input");

    const answer = await resume(parentId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    const written = await children(parentId);
    expect(written.length).toBe(3);
    for (const child of written) expect(await ff.changes(child.id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env1a");
    expect(noValueInOutput()).toBe(true);
  });

  it("the process dies inside an entry after the send → child uncertain, parent uncertain; settled through the child; the parent is partial", async () => {
    const names = [unique(), unique(), unique()];
    const text = fileOf(names);
    const previewId = await preview(text);
    await ff.child({ point: "after_send", action: "crash" });
    await applyOnChild(previewId, text);
    const parentId = await parentOf(previewId);
    const [child] = await children(parentId);
    expect(child?.state).toBe("executing");

    const swept = await ff.sweepNow();
    expect(swept.uncertain).toEqual(expect.arrayContaining([child?.id, parentId]));
    expect((await ff.operation(parentId))?.state).toBe("uncertain");
    expect(await outcomes(parentId)).toEqual(["uncertain", null, null]);
    const unknown = await resume(parentId, text);
    expect(unknown.status).toBe(503);
    expect(unknown.code).toBe("outcome_unknown");

    const verdict = await ff.settle(parentId, { excluded: false });
    expect(verdict.kind).toBe("succeeded");
    expect((await ff.operation(parentId))?.state).toBe("partial");
    expect(await outcomes(parentId)).toEqual(["created", "not_attempted", "not_attempted"]);
    expect(await ff.changes(child?.id ?? "")).toBe(1);
    expect(await ff.f.backend("env1a", names[1] ?? "")).toBeNull();
    await expectIndexMatchesBackend(ff.f, "env1a");
    expect(noValueInOutput()).toBe(true);
  });

  it("a child loses its lock between admission and the marker → outcome_unknown; after the sweep the operator settles the parent from its entries: partial, nothing written (gate review I-1)", async () => {
    const names = [unique(), unique()];
    const text = fileOf(names);
    const previewId = await preview(text);
    await ff.child({ point: "after_admission", action: "terminate_lock" });
    const answer = await ff.f.send("POST", `${ff.f.env("env1a").path}/import/${previewId}/apply`, {
      text,
      to: "second",
    });
    const parentId = await parentOf(previewId);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect(answer.operationId).toBe(parentId);
    expect((await ff.operation(parentId))?.state).toBe("uncertain");

    await ff.sweepNow();
    const [child] = await children(parentId);
    expect(child?.state).toBe("rejected");
    expect(await ff.changes(child?.id ?? "")).toBe(0);

    const verdict = await ff.settle(parentId, { excluded: false });
    expect(verdict.kind).toBe("rejected");
    expect((await ff.operation(parentId))?.state).toBe("partial");
    expect(await outcomes(parentId)).toEqual(["rejected", "not_attempted"]);
    const open = await ff.f.api.superuser.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app.operation WHERE id = $1 AND completed_at IS NULL",
      [parentId],
    );
    expect(open.rows[0]?.count).toBe(0);
    expect(await ff.f.backend("env1a", names[0] ?? "")).toBeNull();
    await expectIndexMatchesBackend(ff.f, "env1a");
    expect(noValueInOutput()).toBe(true);
  });

  it("a failure inside the loop after the parent was accepted → 503 outcome_unknown with the parent's id, not a bare dependency_unavailable; the sweep and a resume finish it (gate review I-2)", async () => {
    const names = [unique(), unique(), unique()];
    const text = fileOf(names);
    const previewId = await preview(text);
    await ff.child({ point: "between_entries", action: "throw" });
    const answer = await ff.f.send("POST", `${ff.f.env("env1a").path}/import/${previewId}/apply`, {
      text,
      to: "second",
    });
    const parentId = await parentOf(previewId);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect(answer.operationId).toBe(parentId);
    expect(await outcomes(parentId)).toEqual(["created", null, null]);

    await ff.child();
    const swept = await ff.sweepNow();
    expect(swept.awaitingInput).toContain(parentId);
    const resumed = await resume(parentId, text);
    expect(resumed.status).toBe(200);
    expect(resumed.body.state).toBe("succeeded");
    for (const child of await children(parentId)) expect(await ff.changes(child.id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env1a");
    expect(noValueInOutput()).toBe(true);
  });

  it("the process dies after the last entry and before the parent is finished → resume answers 200 succeeded without a change", async () => {
    const names = [unique(), unique()];
    const text = fileOf(names);
    const previewId = await preview(text);
    await ff.child({ point: "before_import_finish", action: "crash" });
    await applyOnChild(previewId, text);
    const parentId = await parentOf(previewId);
    expect(await outcomes(parentId)).toEqual(["created", "created"]);
    const before = await children(parentId);

    await ff.sweepNow();
    expect((await ff.operation(parentId))?.state).toBe("awaiting_input");
    const answer = await resume(parentId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    expect(await children(parentId)).toEqual(before);
    for (const child of before) expect(await ff.changes(child.id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env1a");
    expect(noValueInOutput()).toBe(true);
  });
});
