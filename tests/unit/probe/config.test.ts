// Run 2.6: the Worker's configuration carries LIMITS.monitoring, the cron of
// the probe interval and both hosts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import { readJsonc } from "../../../scripts/probe.ts";

const config = readJsonc(
  readFileSync(resolve(import.meta.dirname, "../../../workers/probe/wrangler.jsonc"), "utf8"),
) as { vars: Record<string, string>; triggers: { crons: string[] } };

describe("wrangler.jsonc", () => {
  it("carries the limits of @mykey/contracts", () => {
    const grace = String(LIMITS.monitoring.heartbeatGraceSeconds);
    expect(config.vars.HEARTBEAT_GRACE_SECONDS).toBe(grace);
    expect(config.vars.HEALTH_GRACE_SECONDS).toBe(grace);
    expect(config.vars.REPORTED_GRACE_SECONDS).toBe(grace);
    expect(config.vars.REMINDER_SECONDS).toBe(String(LIMITS.monitoring.alertReminderSeconds));
    expect(LIMITS.monitoring.probeIntervalSeconds).toBe(60);
    expect(config.triggers.crons).toEqual(["* * * * *"]);
  });

  it("watches both hosts by their public names; production is not in service yet", () => {
    expect(JSON.parse(config.vars.HOSTS ?? "[]")).toEqual([
      { name: "staging", hostname: "mykey-staging.nomikey.com" },
      { name: "prod", hostname: "mykey.nomikey.com", inService: false },
    ]);
  });
});
