// Run 9.0 Task A (D-70, FR-1.96): the workspace's colour tokens are legible.
// Text on its background is at least 4.5:1 and a control's edge or the focus
// ring at least 3:1 (WCAG 2.2, 1.4.3 and 1.4.11), in the light set and in the
// dark set. The two sets are read from styles.css itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(import.meta.dirname, "../../../apps/web/src/styles.css"), "utf8");

/** The `--name: #hex` declarations of one block's body. */
function tokensOf(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(match[1] ?? "", (match[2] ?? "").toLowerCase());
  }
  return tokens;
}

function lightTokens(css: string): Map<string, string> {
  const match = /(^|\n):root\s*\{([^}]*)\}/.exec(css);
  return tokensOf(match?.[2] ?? "");
}

function darkTokens(css: string): Map<string, string> {
  const match = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  // The dark set overrides the light one; a token it does not name keeps its light value.
  return new Map([...lightTokens(css), ...tokensOf(match?.[1] ?? "")]);
}

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => channel(Number.parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const BACKGROUNDS = ["bg", "surface", "surface-2"];
const TEXT_ON_BACKGROUNDS = ["text", "muted", "link", "ok", "wait", "warn", "off", "danger"];

/** [foreground, background, minimum]. */
const PAIRS: [string, string, number][] = [
  ...TEXT_ON_BACKGROUNDS.flatMap((fg) =>
    BACKGROUNDS.map((bg): [string, string, number] => [fg, bg, 4.5]),
  ),
  ["brand-text", "brand", 4.5],
  ["nav-active-text", "nav-active", 4.5],
  ["text", "nav-active", 4.5],
  // A control's edge and the focus ring against what they sit on.
  ...BACKGROUNDS.flatMap((bg): [string, string, number][] => [
    ["border-strong", bg, 3],
    ["focus", bg, 3],
    ["brand", bg, 3],
  ]),
];

describe("the colour tokens", () => {
  for (const [scheme, read] of [
    ["light", lightTokens],
    ["dark", darkTokens],
  ] as const) {
    it(`every text token pair is at least 4.5:1 and every control/focus pair at least 3:1, in ${scheme}`, () => {
      const tokens = read(CSS);
      const failures: string[] = [];
      for (const [fg, bg, minimum] of PAIRS) {
        const a = tokens.get(fg);
        const b = tokens.get(bg);
        if (a === undefined || b === undefined) {
          failures.push(`--${fg} on --${bg}: a token is missing`);
          continue;
        }
        const ratio = contrast(a, b);
        if (ratio < minimum) {
          failures.push(`--${fg} ${a} on --${bg} ${b}: ${ratio.toFixed(2)} < ${String(minimum)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("the dark set is a set of its own: it names every token the pairs use", () => {
    const match = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(CSS);
    const own = tokensOf(match?.[1] ?? "");
    const used = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]));
    expect([...used].filter((token) => !own.has(token))).toEqual([]);
  });

  it("the measure is WCAG's (control)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThan(4.5);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});
