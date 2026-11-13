// The provisioner image's health check (Run 3.8, P-57): unhealthy when the last
// sweep tick is older than three intervals.
import { readFileSync } from "node:fs";
import { DEFAULT_SWEEP_SECONDS } from "./config.ts";

export function isHealthy(
  lastSweep: string | null,
  sweepSeconds: number,
  now = Date.now(),
): boolean {
  if (lastSweep === null) return false;
  const at = Date.parse(lastSweep);
  return Number.isFinite(at) && now - at <= 3 * sweepSeconds * 1000;
}

function readLast(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const sweepSeconds = Number(process.env.MYKEY_SWEEP_SECONDS ?? String(DEFAULT_SWEEP_SECONDS));
  const state = process.env.MYKEY_PROVISIONER_STATE_FILE ?? "/tmp/mykey-provisioner/last-sweep";
  process.exit(isHealthy(readLast(state), sweepSeconds) ? 0 : 1);
}
