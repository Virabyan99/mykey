// Run 3.1 Task C (P-42): the logger's second defence. Entries are typed; before
// a line is written, any key with a denied name is replaced at any depth.
import { describe, expect, it } from "vitest";
import { createLogger, redactEntry, type LogEntry } from "@mykey/api";

describe("log redaction", () => {
  it("replaces denied keys at any depth and in any case", () => {
    const entry = {
      event: "test",
      password: "p",
      outer: {
        Authorization: "Bearer x",
        "set-cookie": ["a=b"],
        list: [{ token: "t", ok: 1 }],
        deeper: { Link: "https://x", value: "v", Code: "123456", secret: "s", cookie: "c" },
      },
      kept: "visible",
    };
    expect(redactEntry(entry)).toEqual({
      event: "test",
      password: "[redacted]",
      outer: {
        Authorization: "[redacted]",
        "set-cookie": "[redacted]",
        list: [{ token: "[redacted]", ok: 1 }],
        deeper: {
          Link: "[redacted]",
          value: "[redacted]",
          Code: "[redacted]",
          secret: "[redacted]",
          cookie: "[redacted]",
        },
      },
      kept: "visible",
    });
  });

  it("writes one JSON line per entry, redacted", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log({
      event: "unhandled",
      time: "2026-11-12T00:00:00.000Z",
      requestId: "r",
      routeId: "x.y",
      errorClass: "Error",
    });
    log({ event: "unhandled", password: "hunter2" } as unknown as LogEntry);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(
      true,
    );
    expect(lines[1]?.includes("hunter2")).toBe(false);
  });

  it("the request entry has no field for a body, a query or a URL", () => {
    const request: Extract<LogEntry, { event: "request" }> = {
      event: "request",
      time: "t",
      requestId: "r",
      method: "GET",
      path: "/v1/organizations/:org/projects",
      status: 200,
      durationMs: 1,
      bodyBytesRead: 0,
      peer: null,
      forwardedFor: null,
      forwardedProto: null,
    };
    expect(Object.keys(request).sort()).toEqual([
      "bodyBytesRead",
      "durationMs",
      "event",
      "forwardedFor",
      "forwardedProto",
      "method",
      "path",
      "peer",
      "requestId",
      "status",
      "time",
    ]);
  });
});
