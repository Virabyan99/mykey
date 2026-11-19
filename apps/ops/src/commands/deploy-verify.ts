// Run 6.9 Task B (P-128, D-57): the report that opens the gate after a deploy.
// REQUIRED_CHECKS.deploy: the schema revision the release expects, OpenBao
// readable, the incarnation equal in the database, host.env and OpenBao, the
// control row idle, the journey (sign-in, a reveal's digest, a refused write)
// and the gate closed before this deploy started. Appends operator.deploy
// with the build. Counts and names only.
import { appendAudit } from "@mykey/audit";
import {
  REQUIRED_CHECKS,
  verificationReportSchema,
  type GateRecordV2,
  type VerificationReport,
} from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type { GateExpect } from "@mykey/operations";
import type pg from "pg";
import { storeChecks, type Check, type CheckAnswer, type JourneyResult } from "./restore-verify.ts";

export interface DeployVerifyDeps {
  /** The host's database (maintenance or superuser). */
  pool: pg.Pool;
  /** The host's OpenBao, with a token that may list namespaces and read mykey-meta. */
  admin: OpenBaoAdmin;
  host: string;
  expect: GateExpect;
  origin: GateRecordV2["origin"];
  /** The release's last migration. */
  schemaRevision: string;
  /** The gate record as it was when the deploy closed it (null: there was none). */
  previousGate: string | null;
  now?: () => Date;
}

const DEPLOY_STORE_CHECKS = [
  "schema_revision",
  "openbao_readable",
  "incarnation_three_places",
  "control_row_idle",
] as const;

/** The record the opening replaces, read when the report is made: closed (the deploy's own gate_close), or none. */
export function previousGateClosed(text: string | null): CheckAnswer {
  if (text === null) return { state: "ok", observed: "no record before the deploy" };
  try {
    const record = JSON.parse(text) as { state?: unknown };
    return record.state === "closed"
      ? { state: "ok", observed: "closed" }
      : { state: "failed", observed: `the record said ${String(record.state)}` };
  } catch {
    return { state: "failed", observed: "the record before the deploy did not parse" };
  }
}

export async function deployVerify(
  deps: DeployVerifyDeps,
  journey: JourneyResult | null,
): Promise<VerificationReport> {
  const all = storeChecks({
    ...deps,
    restoreStartedAt: new Date(0),
    given: {},
    boundCidrs: { runtime: [], issuer: [], provisioner: [] },
  });
  const answers: Record<string, CheckAnswer> = {};
  for (const id of DEPLOY_STORE_CHECKS) {
    const run = all[id];
    answers[id] =
      run === undefined
        ? { state: "unknown", observed: "no such check" }
        : await run().catch((error: unknown) => ({
            state: "unknown" as const,
            observed: error instanceof Error ? error.constructor.name : "error",
          }));
  }
  answers.previous_gate_closed = previousGateClosed(deps.previousGate);
  for (const [id, answer] of Object.entries(journey?.checks ?? {})) answers[id] = answer;
  const checks: Check[] = REQUIRED_CHECKS.deploy.map((id) => ({
    id,
    ...(answers[id] ?? { state: "unknown" as const, observed: "not performed" }),
  }));
  const members = Number(
    (await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM app.membership")).rows[0]?.n ??
      "0",
  );
  const report = verificationReportSchema.parse({
    format: "mykey-verification/1",
    host: deps.host,
    ...deps.expect,
    origin: deps.origin,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    checks,
    members,
  });
  await withTransaction(deps.pool, (tx) =>
    appendAudit(tx, {
      action: "operator.deploy",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details: { build: deps.expect.releaseBuild },
    }),
  );
  return report;
}
