// Run 8.4 (P-152): the search countOnHost runs on a host, run here in a local
// sh. The needles and the needle controls arrive on stdin (fd 3 of the search),
// never in the script; only three counts come back.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSearchCounts, searchScript } from "../../harness/search-script.ts";

const word = (label: string) => `${label}${randomBytes(6).toString("hex")}`;

function search(
  producerText: string,
  needles: string[],
  controls: string[],
  needleControls: string[],
) {
  const producer = `printf '%s\\n' ${producerText
    .split("\n")
    .map((line) => `'${line}'`)
    .join(" ")}`;
  const script = searchScript(producer, controls, needleControls.length);
  const result = spawnSync("sh", ["-c", script], {
    input: `${[...needleControls, ...needles].join("\n")}\n`,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return parseSearchCounts(result.stdout);
}

describe("the host search's script", () => {
  it("counts needles, argument controls and needle controls apart, and prints only counts", () => {
    const needle = word("needle");
    const absent = word("absent");
    const control = word("control");
    const traveller = word("traveller");
    const text = `a line with ${needle}\nthe ${control} line\n${traveller} too\nnothing`;
    const counts = search(text, [needle, absent], [control], [traveller]);
    expect(counts).toEqual({ found: 1, controls: 1, needleControls: 1 });
  });

  it("finds no needle where there is none, and still counts both kinds of control", () => {
    const control = word("control");
    const traveller = word("traveller");
    const counts = search(
      `${control} and ${traveller}`,
      [word("n"), word("m")],
      [control],
      [traveller],
    );
    expect(counts).toEqual({ found: 0, controls: 1, needleControls: 1 });
  });

  it("a needle control that is not in the text is counted 0, so the caller can refuse the search", () => {
    const control = word("control");
    const counts = search(`only ${control}`, [word("n")], [control], [word("traveller")]);
    expect(counts).toEqual({ found: 0, controls: 1, needleControls: 0 });
  });

  it("works with no argument control and with no needle control", () => {
    const traveller = word("traveller");
    expect(search(`x ${traveller}`, [word("n")], [], [traveller])).toEqual({
      found: 0,
      controls: 0,
      needleControls: 1,
    });
    const control = word("control");
    const needle = word("needle");
    expect(search(`${control} ${needle}`, [needle], [control], [])).toEqual({
      found: 1,
      controls: 1,
      needleControls: 0,
    });
  });
});
