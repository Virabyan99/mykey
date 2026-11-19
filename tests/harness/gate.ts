// Run 6.7 (P-122): the gate record v2 and the backend incarnation for tests.
// A test API is bound to one host instance, one incarnation and one build; the
// database's control row must carry the same incarnation (set as superuser,
// which the control row's guard admits besides maintenance).
import type pg from "pg";

/** The build every test API runs as (MYKEY_BUILD of a real image). */
export const TEST_BUILD = "0000000";

export interface GateBinding {
  hostInstanceId: string;
  backendIncarnation: string;
  releaseBuild: string;
}

/** A v2 record: open + serving, closed + serving, or closed + verifying. */
export function gateText(
  binding: GateBinding,
  state: "open" | "closed" | "verifying",
  gateEpoch: number,
  origin: { kind: "fresh_install"; id: string } | { kind: "restore"; pairId: string } = {
    kind: "fresh_install",
    id: binding.hostInstanceId,
  },
): string {
  return JSON.stringify({
    version: 2,
    state: state === "open" ? "open" : "closed",
    gateEpoch,
    hostInstanceId: binding.hostInstanceId,
    backendIncarnation: binding.backendIncarnation,
    origin,
    releaseBuild: binding.releaseBuild,
    reportSha256: null,
    phase: state === "verifying" ? "verifying" : "serving",
    writtenAt: new Date().toISOString(),
  });
}

/** Writes the incarnation into the database's control row (a superuser pool). */
export async function setIncarnation(
  superuser: pg.Pool,
  incarnation: string | null,
): Promise<void> {
  await superuser.query("UPDATE app.service_control SET backend_incarnation = $1", [incarnation]);
}
