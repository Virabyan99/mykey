// Throttling of password and factor attempts (P-48). The model and its
// implementation arrive in Run 3.3; Run 3.2 fixes the interface the auth
// routes require, so an API without throttling cannot start by accident.
export type ThrottlePhase = "password" | "factor" | "reset";

export type Admission = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface Throttle {
  /** Counts the attempt; throws when the counter cannot be written. */
  admit(
    phase: ThrottlePhase,
    subject: { source: string; account: string | null },
  ): Promise<Admission>;
  recordFailure(phase: ThrottlePhase, account: string): Promise<void>;
  /** Operator reset only (Run 3.6). */
  clearAccount(accounts: readonly string[]): Promise<void>;
}
