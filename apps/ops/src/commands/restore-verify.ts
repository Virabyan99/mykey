// Run 6.7 Task B (P-124 steps 7 and 8, D-55): the verification report of a
// restore. Every check of REQUIRED_CHECKS.restore is answered: `ok`, `failed`
// with what was observed, or `unknown` when it could not be performed (which
// `mayOpen` refuses like a failure). The checks the restore performed itself
// (the pair's signature and digests, the old credentials presented) come in
// `given`; the journey's come from `verifyJourney`. Counts and names only:
// never a token, a value or a secret id.
import { appendAudit } from "@mykey/audit";
import {
  REQUIRED_CHECKS,
  verificationReportSchema,
  type GateRecordV2,
  type VerificationReport,
} from "@mykey/contracts";
import { readIncarnation, withTransaction } from "@mykey/db";
import { environmentPrefix, namespaceFor, type AppRoleName } from "@mykey/openbao";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type { GateExpect } from "@mykey/operations";
import { verifyOrganization } from "@mykey/operations/operator";
import type pg from "pg";
import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";

export type CheckState = "ok" | "failed" | "unknown";
export interface Check {
  id: string;
  state: CheckState;
  observed: string;
}
export type CheckAnswer = Omit<Check, "id">;

/** What `verifyJourney` answers (Task C): its checks by id. */
export interface JourneyResult {
  checks: Partial<
    Record<
      | "journey_owner_enrolled"
      | "journey_sign_in"
      | "journey_reveal_digest"
      | "journey_mutation_refused",
      CheckAnswer
    >
  >;
}

export interface VerifyDeps {
  /** The restored database, as its superuser. */
  pool: pg.Pool;
  /** The restored OpenBao, with the restore's own root token. */
  admin: OpenBaoAdmin;
  host: string;
  expect: GateExpect;
  origin: GateRecordV2["origin"];
  /** The schema revision the release expects (its last migration). */
  schemaRevision: string;
  /** Secret ids must be newer than this. */
  restoreStartedAt: Date;
  /** Checks the restore performed itself. */
  given: Partial<
    Record<"pair_signature" | "pair_digests" | "old_credentials_refused", CheckAnswer>
  >;
  /** The operator's `--confirm-members <count>`. */
  confirmMembers?: number;
  boundCidrs: Record<AppRoleName, readonly string[]>;
  /**
   * Run 9.7 (R4-2, review RR-1): the accessors of root tokens the operator made on
   * the restored OpenBao after the restore (its next root token, by generate-root).
   * They are the operator's own, not the old world's, and are not counted in the
   * root namespace. Every other accessor still fails machine_accessors_none.
   */
  operatorAccessors?: readonly string[];
  now?: () => Date;
}

const ORGANIZATION_APPROLES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];

const ok = (observed: string): CheckAnswer => ({ state: "ok", observed });
const failed = (observed: string): CheckAnswer => ({ state: "failed", observed });
const zero = (n: number, what: string): CheckAnswer =>
  n === 0 ? ok(`no ${what}`) : failed(`${String(n)} ${what}`);

async function count(pool: pg.Pool, sql: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(sql)).rows[0]?.n ?? "0");
}

/** Every check that reads the restored stores. An exception makes it unknown. */
export function storeChecks(deps: VerifyDeps): Record<string, () => Promise<CheckAnswer>> {
  const { pool, admin } = deps;
  const namespaces = async (): Promise<string[]> => ["", ...(await admin.listNamespaces())];
  return {
    schema_revision: async () => {
      const latest = await pool.query<{ name: string }>(
        "SELECT name FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
      );
      const found = (latest.rows[0]?.name ?? "").replace(/\.sql$/, "");
      return found === deps.schemaRevision
        ? ok(found)
        : failed(`${found}, the release expects ${deps.schemaRevision}`);
    },
    openbao_readable: async () => {
      const orgs = (await admin.listNamespaces()).filter((n) => n.startsWith("org-"));
      for (const namespace of orgs) {
        if ((await admin.readKvConfig(namespace)) === null) return failed(`${namespace}: no kv`);
      }
      return ok(`${String(orgs.length)} namespaces read`);
    },
    sessions_none: async () =>
      zero(await count(pool, "SELECT count(*) AS n FROM auth.session"), "sessions"),
    // An account is usable again only through a reset the operator issued
    // after the restore began (the journey's owner); every other one waits.
    accounts_recovery_pending: async () =>
      zero(
        Number(
          (
            await pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM auth.account_state s
                WHERE s.state NOT IN ('recovery_pending', 'disabled')
                  AND NOT EXISTS (SELECT 1 FROM auth.reset_token t
                                   WHERE t.user_id = s.user_id AND t.consumed_at IS NOT NULL
                                     AND t.created_at >= $1)`,
              [deps.restoreStartedAt],
            )
          ).rows[0]?.n ?? "0",
        ),
        "accounts usable without a reset after the restore",
      ),
    // Nothing of the old world: no reset token or verification older than the restore.
    reset_tokens_none: async () => {
      const older = async (table: string): Promise<number> =>
        Number(
          (
            await pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM auth.${table} WHERE created_at < $1`,
              [deps.restoreStartedAt],
            )
          ).rows[0]?.n ?? "0",
        );
      return zero(
        (await older("reset_token")) + (await older("verification")),
        "reset tokens or verifications of the old world",
      );
    },
    machine_accessors_none: async () => {
      const self = (await admin.lookupSelf()).accessor;
      const operator = new Set(deps.operatorAccessors ?? []);
      let left = 0;
      for (const namespace of await namespaces()) {
        left += (await admin.listAccessors(namespace)).filter(
          (a) => a !== self && !(namespace === "" && operator.has(a)),
        ).length;
      }
      return zero(left, "token accessors besides the restore's own");
    },
    credentials_all_revoked: async () =>
      zero(
        // Session 11: both tables (machine credentials of either kind, automation credentials).
        await count(
          pool,
          `SELECT (SELECT count(*) FROM app.machine_credential WHERE state <> 'revoked')
                + (SELECT count(*) FROM app.automation_credential WHERE state <> 'revoked') AS n`,
        ),
        "credential rows not revoked",
      ),
    approle_secret_ids_rotated: async () => {
      const stale: string[] = [];
      for (const namespace of await namespaces()) {
        const roles: readonly (AppRoleName | "backup")[] =
          namespace === "" ? ["backup"] : ORGANIZATION_APPROLES;
        for (const name of roles) {
          if ((await admin.readAppRole(namespace, name)) === null) continue;
          const accessors = await admin.listSecretIdAccessors(namespace, name);
          const created = await Promise.all(
            accessors.map((a) => admin.secretIdCreatedAt(namespace, name, a)),
          );
          const fresh = created.every(
            (at) => at !== null && at.getTime() >= deps.restoreStartedAt.getTime() - 1_000,
          );
          if (accessors.length !== 1 || !fresh) stale.push(`${namespace || "root"}/${name}`);
        }
      }
      return stale.length === 0 ? ok("one new secret id each") : failed(stale.join(", "));
    },
    root_tokens_revoked: async () => {
      const self = (await admin.lookupSelf()).accessor;
      let roots = 0;
      for (const accessor of await admin.listAccessors("")) {
        if (accessor === self) continue;
        if ((await admin.lookupAccessor("", accessor))?.policies.includes("root") === true)
          roots += 1;
      }
      return zero(roots, "root tokens besides the restore's own");
    },
    control_row_idle: async () => {
      const row = (
        await pool.query<{ mode: string; pair: string | null }>(
          "SELECT capture_mode AS mode, restored_from_pair AS pair FROM app.service_control",
        )
      ).rows[0];
      const pairId = deps.origin.kind === "restore" ? deps.origin.pairId : null;
      return row?.mode === "idle" && row.pair === pairId
        ? ok("idle")
        : failed(`${row?.mode ?? "no row"}, restored from ${row?.pair ?? "nothing"}`);
    },
    incarnation_three_places: async () => {
      const wanted = deps.expect.backendIncarnation;
      const differ: string[] = [];
      if ((await readIncarnation(pool)) !== wanted) differ.push("database");
      for (const namespace of await namespaces()) {
        if ((await admin.readIncarnation(namespace)) !== wanted)
          differ.push(namespace || "openbao root");
      }
      return differ.length === 0
        ? ok("database, OpenBao and host equal")
        : failed(differ.join(", "));
    },
    operations_none_executing: async () =>
      zero(
        await count(
          pool,
          "SELECT count(*) AS n FROM app.operation WHERE state IN ('accepted', 'executing', 'awaiting_input')",
        ),
        "operations not terminal or uncertain",
      ),
    catalog_matches_backend: async () => {
      const differ: string[] = [];
      const orgs = await pool.query<{ id: OrganizationId }>(
        "SELECT id FROM app.organization WHERE state = 'active'",
      );
      for (const { id } of orgs.rows) {
        const { differs } = await verifyOrganization({ admin, boundCidrs: deps.boundCidrs }, id);
        if (differs.length > 0) differ.push(`organization ${id}: ${differs.join(" ")}`);
      }
      const envs = await pool.query<{
        org: OrganizationId;
        project: ProjectId;
        env: EnvironmentId;
      }>(
        `SELECT organization_id AS org, project_id AS project, id AS env
           FROM app.environment WHERE state = 'active' AND kv_ready`,
      );
      for (const { org, project, env } of envs.rows) {
        const kv = await admin.listKvNames(namespaceFor(org), environmentPrefix(project, env));
        const index = (
          await pool.query<{ name: string }>(
            `SELECT name FROM app.secret_index
              WHERE environment_id = $1 AND state IN ('live', 'deleted') ORDER BY name`,
            [env],
          )
        ).rows.map((r) => r.name);
        const missing = index.filter((n) => !kv.includes(n)).length;
        const extra = kv.filter((n) => !index.includes(n)).length;
        if (missing + extra > 0) {
          differ.push(`environment ${env}: ${String(missing)} missing, ${String(extra)} unknown`);
        }
      }
      return differ.length === 0
        ? ok(`${String(orgs.rows.length)} organizations, ${String(envs.rows.length)} environments`)
        : failed(differ.join("; "));
    },
  };
}

/** Run 6.8: a check's `observed` within the report's 2000 characters, saying what was cut. */
export function clipObserved(text: string): string {
  const limit = 2000;
  if (text.length <= limit) return text;
  const keep = limit - 40;
  return `${text.slice(0, keep)} … (+${String(text.length - keep)} characters)`;
}

export async function restoreVerify(
  deps: VerifyDeps,
  journey: JourneyResult | null,
): Promise<VerificationReport> {
  const answers: Record<string, CheckAnswer> = {};
  for (const [id, run] of Object.entries(storeChecks(deps))) {
    answers[id] = await run().catch((error: unknown) => ({
      state: "unknown" as const,
      observed: error instanceof Error ? error.constructor.name : "error",
    }));
  }
  const members = await count(deps.pool, "SELECT count(*) AS n FROM app.membership");
  answers.members_confirmed =
    deps.confirmMembers === members
      ? ok(`${String(members)} members confirmed`)
      : failed(
          `${String(members)} members, confirmed ${deps.confirmMembers === undefined ? "none" : String(deps.confirmMembers)}`,
        );
  for (const [id, answer] of Object.entries(deps.given)) answers[id] = answer;
  for (const [id, answer] of Object.entries(journey?.checks ?? {})) answers[id] = answer;

  const checks: Check[] = REQUIRED_CHECKS.restore.map((id) => {
    const answer = answers[id] ?? { state: "unknown" as const, observed: "not performed" };
    return { id, state: answer.state, observed: clipObserved(answer.observed) };
  });
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
      action: "operator.restore_verify",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details: { checks: checks.length, failed: checks.filter((c) => c.state !== "ok").length },
    }),
  );
  return report;
}

/** P-124: the checks `gate open` performs again itself, right before opening. */
export const RECHECKED = [
  "sessions_none",
  "machine_accessors_none",
  "control_row_idle",
  "incarnation_three_places",
] as const;

export async function recheckForOpen(deps: VerifyDeps): Promise<Check[]> {
  const all = storeChecks(deps);
  const checks: Check[] = [];
  for (const id of RECHECKED) {
    const run = all[id];
    const answer: CheckAnswer =
      run === undefined
        ? { state: "unknown", observed: "no such check" }
        : await run().catch(() => ({ state: "unknown" as const, observed: "error" }));
    checks.push({ id, ...answer });
  }
  return checks;
}
