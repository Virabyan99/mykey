// Run 9.4 (D-71): the one thing the agent may run. It sends its first
// argument, as given, as the body of POST / to the runner, and prints the
// runner's answer. It adds nothing and holds no token; whatever the agent puts
// in the body is what the runner judges.
//
//   node /fixture/ask.mjs '{"action":"fixture-check","requester":"<id>"}'
/* global fetch, console */
import process from "node:process";

const body = process.argv[2] ?? "";
try {
  const answer = await fetch("http://runner:8790/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  console.log(await answer.text());
} catch (error) {
  console.log(JSON.stringify({ ask: "the runner did not answer", error: String(error) }));
  process.exitCode = 1;
}
