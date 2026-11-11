import { describe, expect, it } from "vitest";
import { parseHostStatus } from "../../harness/staging.ts";

const base = {
  host: "staging",
  bootId: "6f1c2f0e-0000-4000-8000-000000000001",
  time: "2026-11-11T18:00:00.250Z",
  containers: {},
  sealed: null,
  sealType: null,
  kmsReachable: null,
  pendingRevert: [],
};

const at = Date.parse("2026-11-11T18:00:00.000Z");

describe("parseHostStatus", () => {
  it("keeps what the host measured about its clock, firewall and SSH listeners", () => {
    const status = parseHostStatus(
      JSON.stringify({
        ...base,
        chronyOffsetMs: 0.412,
        clockSynced: true,
        firewall: { loaded: true, sets: { dns: 1, ntp: 2, apt: 16, registry: 0 } },
        sshListen: ["10.77.2.1:22"],
      }),
      at,
      at + 100,
    );
    expect(status.chronyOffsetMs).toBe(0.412);
    expect(status.clockSynced).toBe(true);
    expect(status.firewall).toEqual({
      loaded: true,
      sets: { dns: 1, ntp: 2, apt: 16, registry: 0 },
    });
    expect(status.sshListen).toEqual(["10.77.2.1:22"]);
    // Host clock minus workstation clock at the middle of the request.
    expect(status.clockOffsetMs).toBe(200);
  });

  it("reports an unsynchronised clock as unknown, never as zero", () => {
    const status = parseHostStatus(
      JSON.stringify({ ...base, chronyOffsetMs: null, clockSynced: false }),
      at,
      at,
    );
    expect(status.chronyOffsetMs).toBeNull();
    expect(status.clockSynced).toBe(false);
  });

  it("says unknown for everything an older status.sh does not print", () => {
    const status = parseHostStatus(JSON.stringify(base), at, at);
    expect(status.chronyOffsetMs).toBeNull();
    expect(status.clockSynced).toBeNull();
    expect(status.firewall).toBeNull();
    expect(status.sshListen).toBeNull();
  });

  it("refuses a firewall report whose set count is not a number", () => {
    expect(() =>
      parseHostStatus(
        JSON.stringify({ ...base, firewall: { loaded: true, sets: { dns: "many" } } }),
        at,
        at,
      ),
    ).toThrow(/firewall/);
  });
});
