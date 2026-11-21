// The search countOnHost runs on a host (Session 4 gate; Run 8.4, P-152), as
// a pure function so a unit test can run it in a local sh.
//
// stdin carries the needle controls (the first `needleControlCount` lines) and
// then the needles. They are read into a shell variable that is never exported
// and reach grep through here-documents on fd 4: never an argument, never the
// producer's stdin (inside a pipeline grep's stdin is the producer's output).
// The argument controls are on the command line: they are not secret. Only
// three counts come back: needles found, argument controls found, needle
// controls found.
import { shQuote } from "@mykey/ops/remote";

const END = "MYKEY_SEARCH_PATTERNS";

export function searchScript(
  producer: string,
  controls: readonly string[],
  needleControlCount: number,
): string {
  const quoted = controls.map((control) => `-e ${shQuote(control)}`).join(" ");
  const lines = [
    "all=$(cat)",
    `m=$( { ${producer}; } </dev/null 2>&1 | grep -o -F -f /dev/fd/4 ${quoted} 4<<${END} | sort -u`,
    "$all",
    END,
    ")",
    `n=$(printf '%s\\n' "$m" | grep -c -v '^$' || true)`,
    controls.length === 0
      ? "known=0"
      : `known=$(printf '%s\\n' "$m" | grep -c -x -F ${quoted} || true)`,
  ];
  if (needleControlCount > 0) {
    lines.push(
      `nc=$(printf '%s\\n' "$all" | head -n ${String(needleControlCount)})`,
      `travelled=$(printf '%s\\n' "$m" | grep -c -x -F -f /dev/fd/4 4<<${END}`,
      "$nc",
      END,
      ")",
    );
  } else {
    lines.push("travelled=0");
  }
  lines.push('all=; nc=; m=; echo "$((n - known - travelled)) $known $travelled"');
  return lines.join("\n");
}

export function parseSearchCounts(stdout: string): {
  found: number;
  controls: number;
  needleControls: number;
} {
  const [found, controls, needleControls] = stdout.trim().split(/\s+/).map(Number);
  return {
    found: found ?? Number.NaN,
    controls: controls ?? Number.NaN,
    needleControls: needleControls ?? Number.NaN,
  };
}
