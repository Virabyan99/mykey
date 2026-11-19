// Run 6.7 (FR-1.69): a restore records the capture time, the pair's age when
// the restore began, the elapsed time of steps 1–7 and of the verification,
// and its result — measured values, never a promise.
import { restoreMeasurements } from "@mykey/ops";
import { describe, expect, it } from "vitest";

describe("restoreMeasurements (FR-1.69)", () => {
  const captureStartedAt = "2026-11-17T03:30:00.000Z";
  const startedAt = new Date("2026-11-18T10:00:00.000Z");
  const restoredAt = new Date("2026-11-18T10:04:30.000Z");

  it("records the capture, the age at restore and the elapsed restore time", () => {
    expect(restoreMeasurements({ captureStartedAt, startedAt, restoredAt })).toEqual({
      captureStartedAt,
      restoreStartedAt: "2026-11-18T10:00:00.000Z",
      ageAtRestoreSeconds: 30 * 3600 + 30 * 60,
      restoreSeconds: 270,
      verifiedAt: null,
      revalidationSeconds: null,
      result: "verifying",
    });
  });

  it("adds the verification's time and result once a report exists", () => {
    const measured = restoreMeasurements({
      captureStartedAt,
      startedAt,
      restoredAt,
      report: { createdAt: "2026-11-18T10:20:30.000Z", failed: 0 },
    });
    expect(measured).toMatchObject({
      verifiedAt: "2026-11-18T10:20:30.000Z",
      revalidationSeconds: 16 * 60,
      result: "verified",
    });
    expect(
      restoreMeasurements({
        captureStartedAt,
        startedAt,
        restoredAt,
        report: { createdAt: "2026-11-18T10:20:30.000Z", failed: 2 },
      }).result,
    ).toBe("failed_checks");
  });
});
