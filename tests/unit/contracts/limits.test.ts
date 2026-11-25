import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

describe("LIMITS", () => {
  it("is exactly the Doc 06 §11 table (a changed number fails here, loudly)", () => {
    expect(LIMITS).toEqual({
      session: {
        idleSeconds: 1800,
        absoluteSeconds: 43200,
        freshTotpSeconds: 600,
        incompleteChallengeSeconds: 600,
      },
      totp: { digits: 6, stepSeconds: 30, skewSteps: 1 },
      recovery: { codeCount: 10 },
      reset: { linkSeconds: 900 },
      secret: {
        nameMaxLength: 128,
        valueMaxBytes: 65536,
        versionsKept: 20,
        reservedPrefix: "SECRETS_",
      },
      project: { nameMinCodePoints: 1, nameMaxCodePoints: 64 },
      environment: { nameMaxLength: 63, maxNames: 1000, maxLiveValueBytes: 8388608 },
      body: {
        jsonMaxBytes: 524288,
        jsonMaxDepth: 16,
        dotenvMaxBytes: 1048576,
        dotenvMaxEntries: 1000,
        authMaxBytes: 16384,
        headersMaxBytes: 16384,
        bearerMaxBytes: 4096,
        passwordMaxBytes: 1024,
      },
      importPreview: { ttlSeconds: 900 },
      completeResponse: { maxBodyBytes: 50331648, metadataAllowanceBytes: 1048576 },
      listing: { defaultLimit: 50, maxLimit: 100, filterMaxLength: 128 },
      rate: {
        perSourcePerMinute: 300,
        perSessionPerMinute: 120,
        perMachineCredentialPerMinute: 60,
        revealPerMinute: 30,
        importExportPerMinute: 5,
        authAttemptsPerMinute: 5,
        authFailuresPerAccount: 5,
        authFailureWindowSeconds: 900,
        authDelaySeconds: 900,
        machineMissesPerSourcePerMinute: 30,
        credentialIssuePerMinute: 5,
        // Not in Doc 06 §11 (D-83, Session 11).
        exchangePerCredentialPerMinute: 10,
        perAutomationCredentialPerMinute: 120,
      },
      concurrency: { httpPerProcess: 64, largePerProcess: 2, apiProcesses: 2, provisionerJobs: 2 },
      db: { apiPool: 20, provisionerPool: 6, opsPool: 4, maxConnections: 100 },
      deadlines: {
        poolAcquireMs: 2000,
        advisoryLockMs: 2000,
        backendCallMs: 5000,
        requestMs: 30000,
        largeRequestMs: 120000,
      },
      operation: { heartbeatSeconds: 15, stuckAlertSeconds: 120, terminalRetentionDays: 30 },
      machineToken: {
        defaultTtlSeconds: 2592000,
        maxTtlSeconds: 2592000,
        expiryWarningSeconds: 604800,
        issuerSessionSeconds: 60,
      },
      // Not in Doc 06 §11 (D-83, Session 11): a year at most, a 15-minute token per exchange.
      runtimeCredential: {
        defaultTtlSeconds: 31536000,
        maxTtlSeconds: 31536000,
        exchangeTtlSeconds: 900,
        maxCidrs: 8,
      },
      // Not in Doc 06 §11 (D-83, Session 11): an hour to a year, a week by default.
      automationCredential: {
        minTtlSeconds: 3600,
        defaultTtlSeconds: 604800,
        maxTtlSeconds: 31536000,
        maxCidrs: 8,
      },
      disk: {
        minFreeBytesPercent: 15,
        minFreeInodesPercent: 10,
        minFreeBytes: 2147483648,
        auditReserveBytes: 2147483648,
      },
      backup: {
        dailyAtUtc: "03:00",
        maxAgeAlertSeconds: 93600,
        eligibilityDays: 30,
        uploadDeadlineSeconds: 7200,
        freezeAlertSeconds: 600,
        cleanupLagTargetSeconds: 172800,
      },
      audit: { retentionDays: 365 },
      monitoring: {
        probeIntervalSeconds: 60,
        heartbeatGraceSeconds: 180,
        kmipCertWarningDays: 30,
        alertReminderSeconds: 3600,
      },
      reveal: { displayMaxSeconds: 30 },
    });
  });

  it("cannot be changed at run time", () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(Object.isFrozen(LIMITS.secret)).toBe(true);
  });
});
