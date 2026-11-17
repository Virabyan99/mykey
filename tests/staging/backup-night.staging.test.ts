// Run 6.5 Task D, checkpoint `backup-first-night` (due 18 Nov 2026 03:30 UTC):
// after the timer's own 03:00 run, that run's pair is eligible and the
// heartbeat's newestEligibleCaptureAt is its capture.
//   MYKEY_CHECKPOINT=backup-first-night pnpm run test:staging -- tests/staging/backup-night.staging.test.ts
import { describe, expect, it } from "vitest";
import { expectSuccess, loadHosts, shQuote, sshExec } from "../harness/staging.ts";

const host = loadHosts().staging;
const DUE = Date.parse("2026-11-18T03:30:00.000Z");

describe("checkpoint backup-first-night", () => {
  it("after the timer's own 03:00 run, the heartbeat's newestEligibleCaptureAt is that capture", async () => {
    if (Date.now() < DUE) throw new Error("checkpoint not due before 2026-11-18T03:30Z");
    const timer = expectSuccess(
      await sshExec(host, "systemctl show -p LastTriggerUSec mykey-backup.timer", { sudo: true }),
      "the timer",
    ).stdout;
    const lastTrigger = Date.parse(
      (/LastTriggerUSec=\w+ (\S+ \S+) UTC/.exec(timer)?.[1] ?? "").replace(" ", "T") + "Z",
    );
    expect(Number.isNaN(lastTrigger), timer).toBe(false);
    expect(new Date(lastTrigger).toISOString().slice(11, 16)).toBe("03:00");
    const query =
      "SELECT to_char(capture_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM app.backup_pair WHERE host = 'staging' AND validation_status = 'eligible' ORDER BY capture_started_at DESC LIMIT 1";
    const newest = expectSuccess(
      await sshExec(
        host,
        `PGPASSWORD=$(cat /etc/mykey/secrets/postgres/superuser-password) docker exec -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -c ${shQuote(query)}`,
        { sudo: true, secretOutput: true },
      ),
      "the newest eligible pair",
    ).stdout.trim();
    const captured = Date.parse(newest);
    expect(captured - lastTrigger).toBeGreaterThanOrEqual(0);
    expect(captured - lastTrigger).toBeLessThan(15 * 60_000);
    const status = JSON.parse(
      expectSuccess(
        await sshExec(host, "/opt/mykey/hosts/checks/status.sh", { sudo: true }),
        "status.sh",
      ).stdout,
    ) as { checks: { backup: { expected: boolean; newestEligibleCaptureAt: string } } };
    expect(status.checks.backup).toEqual({ expected: true, newestEligibleCaptureAt: newest });
  });
});
