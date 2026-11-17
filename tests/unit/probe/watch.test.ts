// Run 6.4 Task D (P-117, D-50): who watches the Worker. A scheduled workflow
// reads the probe's state route; when the last evaluation is older than 10
// minutes, or the route does not answer, it sends one message. Its text holds
// no token.
import { describe, expect, it } from "vitest";
import { watchVerdict, watchText } from "../../../scripts/probe-watch.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const MINUTE = 60_000;

describe("watchVerdict (P-117)", () => {
  it("evaluated 9 minutes ago → no alert", () => {
    expect(watchVerdict({ evaluatedAt: NOW - 9 * MINUTE }, NOW).alert).toBe(false);
  });

  it("evaluated 11 minutes ago → alert", () => {
    const verdict = watchVerdict({ evaluatedAt: NOW - 11 * MINUTE }, NOW);
    expect(verdict.alert).toBe(true);
    expect(verdict.text).toBe("MyKey probe: not evaluated for 11 min (watcher)");
  });

  it("never evaluated, or no answer → alert", () => {
    expect(watchVerdict({ evaluatedAt: null }, NOW)).toEqual({
      alert: true,
      text: "MyKey probe: never evaluated (watcher)",
    });
    expect(watchVerdict(null, NOW)).toEqual({
      alert: true,
      text: "MyKey probe: state route did not answer (watcher)",
    });
  });

  it("the text holds no token", () => {
    const token = "read-token-synthetic-0123456789abcdef";
    const bot = "123456:bot-token-synthetic-abcdefghijkl";
    for (const verdict of [
      watchVerdict(null, NOW),
      watchVerdict({ evaluatedAt: NOW - 30 * MINUTE }, NOW),
      watchVerdict({ evaluatedAt: null }, NOW),
    ]) {
      const text = watchText(verdict, { readToken: token, botToken: bot, chatId: "42" });
      expect(text).not.toContain(token);
      expect(text).not.toContain(bot);
      expect(text).toMatch(/^MyKey probe: /);
    }
  });
});
