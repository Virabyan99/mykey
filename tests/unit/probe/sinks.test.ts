// Run 2.6: what an alert says and how a sink reports failure.
import { describe, expect, it } from "vitest";
import { deliver, formatAlert } from "@mykey/probe/sinks";

const alert = {
  host: "staging",
  condition: "heartbeat_missing",
  kind: "opened",
  sinceMs: Date.UTC(2026, 10, 11, 20, 0, 0),
} as const;

describe("formatAlert", () => {
  it("names host, condition, kind and the UTC time, and nothing else", () => {
    const text = formatAlert(alert);
    expect(text).toContain("staging");
    expect(text).toContain("heartbeat_missing");
    expect(text).toContain("opened");
    expect(text).toContain("2026-11-11T20:00:00Z");
    // No address, URL, token or host name of the deployment.
    expect(text).not.toMatch(/https?:|\.com|\d+\.\d+\.\d+\.\d+|token|bearer/i);
  });
});

describe("deliver", () => {
  const telegram = { kind: "telegram", botToken: "123:synthetic", chatId: "42" } as const;

  it("is true only for a 2xx answer", async () => {
    const calls: { url: string; body: string }[] = [];
    const answering =
      (status: number): typeof fetch =>
      (input, init) => {
        calls.push({ url: input as string, body: init?.body as string });
        // A 204 carries no body.
        return Promise.resolve(new Response(status === 204 ? null : "{}", { status }));
      };
    expect(await deliver(telegram, "text", answering(200))).toBe(true);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:synthetic/sendMessage");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ chat_id: "42", text: "text" });
    expect(await deliver(telegram, "text", answering(500))).toBe(false);
    expect(await deliver(telegram, "text", answering(403))).toBe(false);
    expect(
      await deliver({ kind: "webhook", url: "https://sink.example" }, "t", answering(204)),
    ).toBe(true);
    expect(
      await deliver({ kind: "webhook", url: "https://sink.example" }, "t", answering(500)),
    ).toBe(false);
  });

  it("is false when the request itself fails", async () => {
    const failing: typeof fetch = () => Promise.reject(new Error("network down"));
    expect(await deliver(telegram, "text", failing)).toBe(false);
  });

  it("does not claim e-mail delivery it cannot make", async () => {
    expect(await deliver({ kind: "email", to: "owner@example.test" }, "text")).toBe(false);
  });
});
