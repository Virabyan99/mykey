// The owner bootstrap (FR-1.01, PO-5, D-27): the only way an account comes
// into being in Stage 1. One transaction as `maintenance`, serialised by an
// advisory lock:
//
//   an active owner exists → same e-mail: `already_present`, nothing changes
//   (the password included); another e-mail: `refused`.
//   otherwise → user, credential account (Better Auth's hash), account state
//   `enrollment_pending`, organization `provisioning`, owner membership, audit
//   `operator.bootstrap` (ids only).
//
// Interrupted anywhere, the transaction leaves nothing; repeated, it ends with
// exactly one owner.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import type { OrganizationId, UserId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import type { Auth } from "../auth.ts";
import { checkPassword } from "../password-rule.ts";

export const BOOTSTRAP_POINTS = [
  "lock",
  "user",
  "account",
  "account_state",
  "organization",
  "membership",
  "audit",
] as const;

export type BootstrapPoint = (typeof BOOTSTRAP_POINTS)[number];

export type BootstrapResult =
  | { outcome: "created" | "already_present"; userId: UserId; organizationId: OrganizationId }
  | { outcome: "refused"; reason: "another_owner_exists" | "password_rejected" };

export interface BootstrapDeps {
  auth: Auth;
  /** Logged in as `maintenance`. */
  pool: pg.Pool;
  /** Tests only: called after each statement. */
  crashAt?: (point: BootstrapPoint) => void;
}

/** E-mail addresses are stored the way Better Auth looks them up at sign-in. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export async function bootstrapOwner(
  deps: BootstrapDeps,
  input: { email: string; password: string },
): Promise<BootstrapResult> {
  const email = normalizeEmail(input.email);
  const crash = deps.crashAt ?? (() => undefined);
  return withTransaction(deps.pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('mykey.bootstrap'))");
    crash("lock");
    const owners = await tx.query<{
      user_id: UserId;
      organization_id: OrganizationId;
      email: string;
    }>(
      `SELECT m.user_id, m.organization_id, u.email
         FROM app.membership m JOIN auth."user" u ON u.id = m.user_id
        WHERE m.role = 'owner' AND m.state = 'active'
        ORDER BY m.id
        LIMIT 2`,
    );
    const owner = owners.rows[0];
    if (owner !== undefined) {
      if (owners.rows.length === 1 && owner.email === email) {
        return {
          outcome: "already_present",
          userId: owner.user_id,
          organizationId: owner.organization_id,
        };
      }
      return { outcome: "refused", reason: "another_owner_exists" };
    }
    if (!checkPassword(input.password).ok)
      return { outcome: "refused", reason: "password_rejected" };

    const hash = await (await deps.auth.$context).password.hash(input.password);
    const userId = randomUUID() as UserId;
    const organizationId = randomUUID() as OrganizationId;
    await tx.query(
      'INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [userId, "Owner", email],
    );
    crash("user");
    await tx.query(
      `INSERT INTO auth.account (id, account_id, provider_id, user_id, password)
       VALUES ($1, $2, 'credential', $3, $4)`,
      [randomUUID(), userId, userId, hash],
    );
    crash("account");
    await tx.query(
      "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
      [userId],
    );
    crash("account_state");
    await tx.query(
      "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'provisioning')",
      [organizationId, `org-${organizationId}`],
    );
    crash("organization");
    await tx.query(
      `INSERT INTO app.membership (id, organization_id, user_id, role, state)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [randomUUID(), organizationId, userId],
    );
    crash("membership");
    await appendAudit(tx, {
      action: "operator.bootstrap",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId,
      target: { kind: "user", id: userId },
      outcome: "success",
      requestId: null,
      operationId: null,
      details: {},
    });
    crash("audit");
    return { outcome: "created", userId, organizationId };
  });
}
