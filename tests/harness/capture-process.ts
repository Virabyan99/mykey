// Run 6.5 Task B: a capture coordinator in a process of its own, for
// tests/fault/capture/crash.test.ts to kill. stdin: one JSON line
// { database, owner, stopAt, scratchRoot }. It begins a capture as
// maintenance and stops at `stopAt` for ever, printing one JSON line when it
// gets there: "draining" is reached inside beginCapture (the test waits on
// the control row and an executing operation it planted); "capturing" after
// beginCapture; "artifacts" after three files are written into
// <scratchRoot>/<pairId>.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPool, type DbTarget } from "@mykey/db";
import { beginCapture } from "@mykey/operations/operator";

interface Input {
  database: DbTarget;
  owner: string;
  stopAt: "draining" | "capturing" | "artifacts";
  scratchRoot: string;
}

const input = await new Promise<Input>((resolve) => {
  let text = "";
  process.stdin.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    const end = text.indexOf("\n");
    if (end !== -1) resolve(JSON.parse(text.slice(0, end)) as Input);
  });
});

const pool = createPool(input.database, { max: 2 });
process.stdout.write(`${JSON.stringify({ started: true })}\n`);
const begun = await beginCapture(pool, input.owner, { drainDeadlineMs: 600_000 });
if (begun.kind !== "capturing") {
  process.stdout.write(`${JSON.stringify({ busy: begun.reason })}\n`);
  process.exit(75);
}
if (input.stopAt === "artifacts") {
  const directory = join(input.scratchRoot, begun.pairId);
  mkdirSync(directory, { recursive: true });
  for (const name of ["postgres.dump", "globals.sql", "openbao.snap"]) {
    writeFileSync(join(directory, name), "synthetic artifact\n");
  }
}
process.stdout.write(`${JSON.stringify({ at: input.stopAt, pairId: begun.pairId })}\n`);
// Until it is killed.
setInterval(() => undefined, 60_000);
