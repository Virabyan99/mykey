// Run 6.8 (P-125, D-56; AC-1.28, AC-1.43, AC-1.44, PO-22): staging rebuilt on
// a clean host from R2 and the custody set alone, timed, with the refusals.
// The clean host is production's server, reinstalled and lent (hosts.json
// `drill`). The file runs in order and resumes: each step is recorded in
// ~/.mykey/drill/state.json, and a rerun skips what is done (tests/harness/drill.ts).
//
//   B  staging: the drill's content, pair P, the changes after P, declared lost
//   C  the drill host: install, restore (1–7), the owner's return, the report (8)
//   D  what must stay closed (before the opening)
//   C9 the opening; then what the restored service is and is not
//   E  staging back in service; drill.json
//
// Machine tokens, cookies and passwords live in the state file only (0600,
// outside the repository); drill.json holds ids, digests and times.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as OTPAuth from "otpauth";
import { codeAt, createAuth, ephemeralKeys, stepAt } from "@mykey/auth";
import { createPool } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import {
  DRILL_DIR,
  drillHost,
  fence,
  hostSql,
  hostTs,
  hostTsOk,
  readState,
  requestAt,
  sessionOf,
  sha256,
  step,
  writeEvidence,
  writeState,
  type Answer,
  type DrillState,
} from "../harness/drill.ts";
import { connectStaging, loadHosts, registerSecret, sshExec } from "../harness/staging.ts";
import {
  STAGING_OWNER_EMAIL,
  freshCode,
  readCustody,
  stagingOwnerSession,
  writeCustody,
} from "../harness/staging-owner.ts";

const RELEASE = process.env.MYKEY_DRILL_RELEASE ?? join(homedir(), "mykey-release", "host-v0.6.1");
const hosts = loadHosts();
const STAGING = `https://${hosts.staging.hostname}`;
const DRILL = `https://${hosts.drill?.hostname ?? "mykey-drill.nomikey.com"}`;
const SECRETS = 50;
const HOUR = 3_600_000;

const journeyTarget = JSON.parse(
  readFileSync(
    join(homedir(), ".mykey", "secrets", "hosts", "staging", "deploy-journey.json"),
    "utf8",
  ),
) as { organizationId: string };
const ORG = journeyTarget.organizationId;
const O = `/v1/organizations/${ORG}`;

const canary = (): string => {
  const value = ["MYKEY", "CANARY", randomBytes(16).toString("hex")].join("_");
  registerSecret(value);
  return value;
};

/** A request that waits out a rate limit (429) the product answers, up to five times. */
async function call(
  origin: string,
  method: string,
  path: string,
  init: Parameters<typeof requestAt>[3] = {},
): Promise<Answer> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await requestAt(origin, method, path, init);
    if (answer.status !== 429 || attempt === 5) return answer;
    await sleep(15_000);
  }
}

const idem = () => ({ "idempotency-key": randomUUID() });

function data(state: DrillState, key: string): unknown {
  const value = state.data[key];
  if (value === undefined) throw new Error(`drill state has no ${key}`);
  return value;
}

interface Seeded {
  projectId: string;
  envs: { dev: string; second: string; secondName: string };
  secrets: { name: string; env: "dev" | "second"; sha256: string }[];
  liveToken: string;
  liveCredentialId: string;
  revokeToken: string;
  revokeCredentialId: string;
  admin: { id: string; email: string; password: string; cookie: string; totpSecret: string };
  ownerCookieAtP: string;
}

const envPath = (seeded: Seeded, env: "dev" | "second") =>
  `${O}/projects/${seeded.projectId}/environments/${seeded.envs[env]}`;

describe("the clean-host restore drill (P-125)", () => {
  // ------------------------------------------------------------------ B: staging
  it(
    "B1: the drill's content on staging: a project, two environments, 50 secrets, two tokens, an admin",
    async () => {
      await step("B1-seed", async (state) => {
        const { cookie } = await stagingOwnerSession();
        const created = await call(STAGING, "POST", `${O}/projects`, {
          body: { name: `Drill ${randomUUID().slice(0, 6)}` },
          cookie,
          headers: idem(),
        });
        expect(created.status, created.body).toBe(201);
        const result = (
          JSON.parse(created.body) as {
            result: { projectId: string; developmentEnvironmentId: string };
          }
        ).result;
        const second = await call(
          STAGING,
          "POST",
          `${O}/projects/${result.projectId}/environments`,
          {
            body: { name: "staging" },
            cookie,
            headers: idem(),
          },
        );
        expect(second.status, second.body).toBe(201);
        const secondId = (JSON.parse(second.body) as { result: { environmentId: string } }).result
          .environmentId;
        for (const deadline = Date.now() + 120_000; ;) {
          const states = await hostSql(
            hosts.staging,
            `SELECT state FROM app.environment WHERE id IN ('${result.developmentEnvironmentId}', '${secondId}')`,
          );
          if (states.length === 2 && states.every((s) => s === "active")) break;
          if (Date.now() > deadline) throw new Error(`environments: ${states.join(",")}`);
          await sleep(2_000);
        }
        const seeded: Seeded = {
          projectId: result.projectId,
          envs: { dev: result.developmentEnvironmentId, second: secondId, secondName: "staging" },
          secrets: [],
          liveToken: "",
          liveCredentialId: "",
          revokeToken: "",
          revokeCredentialId: "",
          admin: { id: "", email: "", password: "", cookie: "", totpSecret: "" },
          ownerCookieAtP: "",
        };
        for (let i = 1; i <= SECRETS; i += 1) {
          const env = i <= SECRETS / 2 ? "dev" : "second";
          const name = `DRILL_${String(i).padStart(3, "0")}`;
          const value = canary();
          const written = await call(STAGING, "POST", `${envPath(seeded, env)}/secrets`, {
            body: { name, value },
            cookie,
            headers: idem(),
          });
          expect(written.status, `${name}: ${written.body}`).toBe(201);
          seeded.secrets.push({ name, env, sha256: sha256(value) });
        }
        for (const which of ["live", "revoke"] as const) {
          // credentials.issue needs a second factor just verified.
          const issued = await call(STAGING, "POST", `${envPath(seeded, "dev")}/credentials`, {
            body: { name: `drill-${which}`, ttlSeconds: 86_400 },
            cookie: (await stagingOwnerSession()).cookie,
            headers: idem(),
          });
          expect(issued.status, issued.body).toBe(201);
          const body = JSON.parse(issued.body) as {
            token: string;
            credential: { credentialId: string };
          };
          registerSecret(body.token);
          if (which === "live") {
            seeded.liveToken = body.token;
            seeded.liveCredentialId = body.credential.credentialId;
          } else {
            seeded.revokeToken = body.token;
            seeded.revokeCredentialId = body.credential.credentialId;
          }
        }
        seeded.admin = await makeAdmin();
        seeded.ownerCookieAtP = (await stagingOwnerSession()).cookie;
        state.data.seeded = seeded;
      });
    },
    HOUR,
  );

  it(
    "B2: pair P, captured by the unit, eligible",
    async () => {
      await step("B2-capture", async (state) => {
        const unit = "mykey-backup.service";
        const before = await hostSql(
          hosts.staging,
          "SELECT coalesce(to_json(max(capture_started_at))#>>'{}', '') FROM app.backup_pair WHERE host = 'staging'",
        );
        await sshExec(hosts.staging, `systemctl start --no-block ${unit}`, { sudo: true });
        await sleep(2_000);
        for (const deadline = Date.now() + 1_800_000; ;) {
          const shown = (
            await sshExec(hosts.staging, `systemctl show -p ActiveState ${unit}`, { sudo: true })
          ).stdout;
          if (/ActiveState=(inactive|failed)/.test(shown)) break;
          if (Date.now() > deadline) throw new Error("the backup unit did not finish");
          await sleep(3_000);
        }
        const [row] = await hostSql(
          hosts.staging,
          `SELECT id, validation_status, to_json(capture_started_at)#>>'{}' FROM app.backup_pair
          WHERE host = 'staging' ORDER BY capture_started_at DESC LIMIT 1`,
        );
        const [pairId = "", status = "", capturedAt = ""] = (row ?? "").split("|");
        expect(
          Date.parse(capturedAt) > Date.parse(before[0] ?? "1970-01-01T00:00:00Z"),
          "a new pair",
        ).toBe(true);
        expect(status).toBe("eligible");
        state.data.pairId = pairId;
        state.data.pairCapturedAt = new Date(capturedAt).toISOString();
      });
    },
    HOUR,
  );

  it(
    "B3: the changes after P (the owner's reset: password, TOTP, codes; a sign-out; a revoked token; the admin removed; a secret; a token)",
    async () => {
      await step("B3-after-P", async (state) => {
        const seeded = data(state, "seeded") as Seeded;
        const admin = seeded.admin;
        // The owner's return through a reset link: a new password, a new
        // authenticator, new recovery codes. Custody follows at each step.
        const passwordAtP = readCustody("owner-password");
        if (passwordAtP === null) throw new Error("no owner-password in custody");
        state.data.ownerPasswordAtP = passwordAtP;
        writeState(state);
        await hostTsOk([
          "staging",
          "ops",
          "reset-account",
          "--email",
          STAGING_OWNER_EMAIL,
          "--kind",
          "mfa",
        ]);
        const resetToken = newestResetToken();
        const newPassword = canary().toLowerCase();
        const completed = await call(STAGING, "POST", "/v1/auth/reset/complete", {
          body: { token: resetToken, newPassword },
        });
        expect(completed.status, completed.body).toBe(200);
        writeCustody("owner-password", newPassword);
        const challenge = sessionOf(completed);
        const enrolled = await call(STAGING, "POST", "/v1/auth/totp/enroll", {
          body: {},
          cookie: challenge,
        });
        expect(enrolled.status, enrolled.body).toBe(200);
        const { secret } = JSON.parse(enrolled.body) as { secret: string };
        registerSecret(secret);
        writeCustody("owner-totp-seed", secret);
        const activated = await call(STAGING, "POST", "/v1/auth/totp/activate", {
          body: { code: await freshCode(OTPAuth.Secret.fromBase32(secret).bytes) },
          cookie: challenge,
        });
        expect(activated.status, activated.body).toBe(200);
        // One session signed out; one left live.
        const other = (await stagingOwnerSession()).cookie;
        const out = await call(STAGING, "POST", "/v1/auth/sign-out", { body: {}, cookie: other });
        expect(out.status, out.body).toBe(200);
        state.data.ownerCookieLive = (await stagingOwnerSession()).cookie;
        const { cookie } = await stagingOwnerSession();
        const revoked = await call(
          STAGING,
          "POST",
          `${envPath(seeded, "dev")}/credentials/${seeded.revokeCredentialId}/revoke`,
          { body: { confirmed: true }, cookie, headers: idem() },
        );
        expect(revoked.status, revoked.body).toBe(200);
        await hostSql(hosts.staging, `DELETE FROM app.membership WHERE user_id = '${admin.id}'`);
        const after = canary();
        const written = await call(STAGING, "POST", `${envPath(seeded, "dev")}/secrets`, {
          body: { name: "DRILL_AFTER_P", value: after },
          cookie,
          headers: idem(),
        });
        expect(written.status, written.body).toBe(201);
        const issued = await call(STAGING, "POST", `${envPath(seeded, "dev")}/credentials`, {
          body: { name: "drill-after-p", ttlSeconds: 86_400 },
          cookie: (await stagingOwnerSession()).cookie,
          headers: idem(),
        });
        expect(issued.status, issued.body).toBe(201);
        state.data.afterPToken = (JSON.parse(issued.body) as { token: string }).token;
      });
    },
    HOUR,
  );

  it(
    "B4: staging declared lost: gate closed, executors stopped; from here staging is fenced",
    async () => {
      await step("B4-lost", async (state) => {
        await hostTsOk(["staging", "gate", "close"]);
        await hostTsOk(["staging", "quiesce"], { timeoutMs: 600_000 });
        state.data.lostAt = new Date().toISOString();
      });
      fence(true);
      await expect(sshExec(hosts.staging, "true")).rejects.toThrow(/fenced/);
    },
    HOUR,
  );

  // --------------------------------------------------------------- C: drill host
  it(
    "C1: the release on the clean host, its stack, its OpenBao, its database and keys; closed",
    async () => {
      fence(true);
      await step(
        "C1-install",
        async () => {
          // The pinned okms: the restore checks the pair's seal key with it.
          await hostTsOk([
            "drill",
            "kms-install",
            process.env.MYKEY_OKMS_TAR ??
              join(homedir(), "mykey-tmp", "okms-cli-linux-x86_64.tar.gz"),
          ]);
          await hostTsOk(["drill", "deploy", "--release", RELEASE, "--install-only"]);
          // Upstream images by digest, in a maintenance window (network.md): a
          // clean host's egress reaches the registry only inside one.
          await hostTsOk(
            [
              "drill",
              "maint",
              "10",
              "--",
              "docker",
              "compose",
              "--env-file",
              "/etc/mykey/host.env",
              "-f",
              "/opt/mykey/compose/host.compose.yml",
              "-p",
              "mykey",
              "pull",
              "--quiet",
              "postgres",
              "openbao",
              "edge",
            ],
            { timeoutMs: 900_000 },
          );
          // The restore's restic runs from the pinned image (backup.sh's digest).
          await hostTsOk(
            [
              "drill",
              "maint",
              "5",
              "--",
              "docker",
              "pull",
              "-q",
              "restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510",
            ],
            { timeoutMs: 600_000 },
          );
          await hostTsOk(["drill", "up"], { timeoutMs: 1_200_000 });
          await hostTsOk(["drill", "bao-init"], { timeoutMs: 600_000 });
          await hostTsOk(["drill", "db-init"], { timeoutMs: 600_000 });
          await hostTsOk(["drill", "keys", "init"]);
          // The job timers; the heartbeat units without a probe token (the drill
          // host is not in the probe): status.sh still writes the capacity record.
          await hostTsOk(["drill", "timers"]);
          await sshExec(
            drillHost(),
            [
              "install -m 0644 /opt/mykey/hosts/systemd/mykey-heartbeat.service /opt/mykey/hosts/systemd/mykey-heartbeat.timer /etc/systemd/system/",
              "systemctl daemon-reload",
              "systemctl enable --now mykey-heartbeat.timer",
            ].join(" && "),
            { sudo: true },
          );
          await hostTsOk(["drill", "quiesce"], { timeoutMs: 600_000 });
        },
        { timed: true },
      );
    },
    2 * HOUR,
  );

  it(
    "C2: restore steps 1–7 from R2: P picked by listing, verified, restored, closed + verifying",
    async () => {
      fence(true);
      await step(
        "C2-restore",
        async (state) => {
          const output = await hostTsOk(
            ["drill", "restore", "--source", "staging", "--newest", "--organization", ORG],
            {
              timeoutMs: 2 * HOUR,
            },
          );
          expect(output).toContain(
            `pair ${data(state, "pairId") as string} restored; closed + verifying`,
          );
        },
        { timed: true },
      );
      const gate = JSON.parse(
        (await sshExec(drillHost(), "cat /etc/mykey/gate/gate.json", { sudo: true })).stdout,
      ) as { state: string; phase: string };
      expect(gate).toMatchObject({ state: "closed", phase: "verifying" });
    },
    2 * HOUR,
  );

  it(
    "C3: the owner's return: the organization verified, credentials reconciled, the operator's reset",
    async () => {
      fence(true);
      await step(
        "C3-owner",
        async (state) => {
          await hostTsOk(["drill", "ops", "verify-organization", "--organization", ORG]);
          // Pair P holds Session 2's spike organizations: no member, no namespace
          // left in OpenBao. They are marked for review (the backend is missing),
          // as the product's own reconcile would; the report checks active ones.
          const marked = await hostSql(
            drillHost(),
            `WITH orgs AS (
               UPDATE app.organization o SET state = 'needs_review', review_reason = 'namespace_missing'
                WHERE o.state = 'active' AND o.id <> '${ORG}'
                  AND NOT EXISTS (SELECT 1 FROM app.membership m WHERE m.organization_id = o.id)
               RETURNING o.id),
             envs AS (
               UPDATE app.environment e SET state = 'needs_review', review_reason = 'namespace_missing'
                WHERE e.state = 'active' AND e.organization_id IN (SELECT id FROM orgs)
               RETURNING e.id)
             SELECT (SELECT count(*) FROM orgs), (SELECT count(*) FROM envs)`,
          );
          const [orgs = "0", envsMarked = "0"] = (marked[0] ?? "").split("|");
          state.data.markedForReview = {
            organizations: Number(orgs),
            environments: Number(envsMarked),
          };
          writeState(state);
          // restore.md: every environment (staging holds 110 active ones); every exit kept.
          const envs = await hostSql(
            drillHost(),
            "SELECT id FROM app.environment WHERE state = 'active'",
          );
          const exits: Record<string, number> = {};
          const started = Date.now();
          for (const env of envs) {
            const run = await hostTs([
              "drill",
              "ops",
              "reconcile-credentials",
              "--environment",
              env,
            ]);
            exits[String(run.code)] = (exits[String(run.code)] ?? 0) + 1;
            if (run.code !== 0) console.log(`reconcile ${env}: ${run.output.slice(-400)}`);
          }
          state.data.reconcile = {
            environments: envs.length,
            exits,
            seconds: Math.round((Date.now() - started) / 1000),
          };
          writeState(state);
          expect(exits).toEqual({ "0": envs.length });
          await hostTsOk([
            "drill",
            "ops",
            "reset-account",
            "--email",
            STAGING_OWNER_EMAIL,
            "--kind",
            "mfa",
          ]);
        },
        { timed: true },
      );
    },
    HOUR,
  );

  it(
    "C4: restore-verify --journey: the owner through the listener; every check ok",
    async () => {
      fence(true);
      await step(
        "C4-report",
        async (state) => {
          // A journey uses its reset link up: each attempt gets its own.
          await hostTsOk([
            "drill",
            "ops",
            "reset-account",
            "--email",
            STAGING_OWNER_EMAIL,
            "--kind",
            "mfa",
          ]);
          const [members = "0"] = await hostSql(drillHost(), "SELECT count(*) FROM app.membership");
          state.data.members = Number(members);
          await hostTsOk(["drill", "restore-verify", "--confirm-members", members, "--journey"]);
        },
        { timed: true },
      );
    },
    HOUR,
  );

  // ------------------------------------------------------ D: what stays closed
  it(
    "D: refused — open without a report, with a stale one, with another incarnation's; an ineligible pair",
    async () => {
      fence(true);
      await step("D-negative", async (state) => {
        const reportFile = join(
          homedir(),
          ".mykey",
          "secrets",
          "hosts",
          "drill",
          "restore-report.json",
        );
        const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
        const negative: { name: string; refused: boolean; cause: string }[] = [];
        const gateState = async () =>
          (
            JSON.parse(
              (await sshExec(drillHost(), "cat /etc/mykey/gate/gate.json", { sudo: true })).stdout,
            ) as { state: string }
          ).state;
        const attempt = async (name: string, args: string[]) => {
          const run = await hostTs(args);
          const cause =
            run.output
              .split("\n")
              .filter((line) => /refused|needs|no eligible|not eligible|error/i.test(line))
              .at(-1)
              ?.slice(0, 200) ?? "";
          negative.push({
            name,
            refused: run.code !== 0 && (await gateState()) === "closed",
            cause,
          });
        };
        await attempt("gate open without a report", ["drill", "gate", "open"]);
        const write = (name: string, changed: Record<string, unknown>) => {
          const file = join(DRILL_DIR, name);
          writeFileSync(file, JSON.stringify({ ...report, ...changed }, null, 2));
          return file;
        };
        await attempt("a report older than 30 minutes", [
          "drill",
          "gate",
          "open",
          "--report",
          write("stale-report.json", {
            createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
          }),
        ]);
        await attempt("the report of another incarnation", [
          "drill",
          "gate",
          "open",
          "--report",
          write("foreign-report.json", { backendIncarnation: randomUUID() }),
        ]);
        const [ineligible] = await hostSql(
          drillHost(),
          "SELECT id FROM app.backup_pair WHERE host = 'staging' AND validation_status = 'ineligible' LIMIT 1",
        );
        if (ineligible !== undefined) {
          await attempt("--pair naming an ineligible pair", [
            "drill",
            "restore",
            "--source",
            "staging",
            "--pair",
            ineligible,
          ]);
        }
        state.data.negative = negative;
        expect(negative.filter((n) => !n.refused)).toEqual([]);
      });
    },
    HOUR,
  );

  it(
    "C9: the opening: a fresh journey and report, gate open",
    async () => {
      fence(true);
      await step(
        "C9-open",
        async (state) => {
          await hostTsOk([
            "drill",
            "ops",
            "reset-account",
            "--email",
            STAGING_OWNER_EMAIL,
            "--kind",
            "mfa",
          ]);
          const members = String(data(state, "members"));
          await hostTsOk([
            "drill",
            "restore-verify",
            "--confirm-members",
            members,
            "--journey",
            "--open",
          ]);
          state.data.gateOpenedAt = new Date().toISOString();
          const report = readFileSync(
            join(homedir(), ".mykey", "secrets", "hosts", "drill", "restore-report.json"),
            "utf8",
          );
          state.data.report = {
            sha256: sha256(report),
            checks: (JSON.parse(report) as { checks: { id: string; state: string }[] }).checks.map(
              (c) => ({ id: c.id, state: c.state }),
            ),
          };
        },
        { timed: true },
      );
      const gate = JSON.parse(
        (await sshExec(drillHost(), "cat /etc/mykey/gate/gate.json", { sudo: true })).stdout,
      ) as { state: string; origin: { kind: string } };
      expect(gate).toMatchObject({ state: "open", origin: { kind: "restore" } });
    },
    HOUR,
  );

  // ------------------------------------------- after the opening, the drill host
  it(
    "after: the 50 secrets reveal with their digests; the one written after P is absent",
    async () => {
      const state = readState();
      const seeded = data(state, "seeded") as Seeded;
      const cookie = await drillOwnerSession();
      for (const secret of seeded.secrets) {
        const answer = await call(
          DRILL,
          "POST",
          `${envPath(seeded, secret.env)}/secrets/${secret.name}/reveal`,
          {
            body: {},
            cookie,
          },
        );
        expect(answer.status, secret.name).toBe(200);
        expect(sha256((JSON.parse(answer.body) as { value: string }).value), secret.name).toBe(
          secret.sha256,
        );
      }
      const absent = await call(
        DRILL,
        "POST",
        `${envPath(seeded, "dev")}/secrets/DRILL_AFTER_P/reveal`,
        {
          body: {},
          cookie,
        },
      );
      expect(absent.status).toBe(404);
    },
    HOUR,
  );

  it(
    "after: the old credentials are refused — three machine tokens, two sessions, two passwords",
    async () => {
      const state = readState();
      const seeded = data(state, "seeded") as Seeded;
      const refused: Record<string, number> = {};
      const keys = (token: string) =>
        requestAt(
          DRILL,
          "GET",
          `/v1/machine/projects/${seeded.projectId}/environments/development/keys`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
      refused.token_live_at_P = (await keys(seeded.liveToken)).status;
      refused.token_revoked_after_P = (await keys(seeded.revokeToken)).status;
      refused.token_issued_after_P = (await keys(data(state, "afterPToken") as string)).status;
      refused.owner_session_at_P = (
        await requestAt(DRILL, "GET", "/v1/organizations", { cookie: seeded.ownerCookieAtP })
      ).status;
      refused.admin_session_at_P = (
        await requestAt(DRILL, "GET", "/v1/organizations", { cookie: seeded.admin.cookie })
      ).status;
      const signIn = async (email: string, password: string) => {
        const answer = await requestAt(DRILL, "POST", "/v1/auth/sign-in/email", {
          body: { email, password },
        });
        if (answer.status !== 200) return answer.status;
        // A password alone is not a session that can read anything.
        return (await requestAt(DRILL, "GET", "/v1/organizations", { cookie: sessionOf(answer) }))
          .status;
      };
      refused.owner_session_after_P = (
        await requestAt(DRILL, "GET", "/v1/organizations", {
          cookie: data(state, "ownerCookieLive") as string,
        })
      ).status;
      refused.admin_password_at_P = await signIn(seeded.admin.email, seeded.admin.password);
      refused.owner_password_at_P = await signIn(
        STAGING_OWNER_EMAIL,
        data(state, "ownerPasswordAtP") as string,
      );
      // Staging's current password (set after P by the reset) is not the drill host's either.
      refused.owner_password_after_P = await signIn(
        STAGING_OWNER_EMAIL,
        readFileSync(
          join(homedir(), ".mykey", "secrets", "hosts", "staging", "owner-password"),
          "utf8",
        ).trim(),
      );
      state.data.oldCredentials = refused;
      writeState(state);
      for (const [name, status] of Object.entries(refused)) {
        expect([401, 403, 404], `${name}: ${String(status)}`).toContain(status);
      }
    },
    HOUR,
  );

  it(
    "after: a new token reads the environment through the machine route; the drill host is healthy",
    async () => {
      const state = readState();
      const seeded = data(state, "seeded") as Seeded;
      const cookie = await drillOwnerSession();
      const issued = await call(DRILL, "POST", `${envPath(seeded, "dev")}/credentials`, {
        body: { name: "drill-restored", ttlSeconds: 3_600 },
        cookie,
        headers: idem(),
      });
      expect(issued.status, issued.body).toBe(201);
      const token = (JSON.parse(issued.body) as { token: string }).token;
      registerSecret(token);
      const resolved = await requestAt(
        DRILL,
        "POST",
        `/v1/machine/projects/${seeded.projectId}/environments/development/resolve`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(resolved.status, resolved.body.slice(0, 200)).toBe(200);
      const entries = (JSON.parse(resolved.body) as { entries: { name: string; value: string }[] })
        .entries;
      const digests = new Map(entries.map((e) => [e.name, sha256(e.value)]));
      for (const secret of seeded.secrets.filter((s) => s.env === "dev")) {
        expect(digests.get(secret.name), secret.name).toBe(secret.sha256);
      }
      const health = await fetch(`${DRILL}/health`);
      expect(health.status).toBe(200);
      const status = await hostTsOk(["drill", "status"], { timeoutMs: 600_000 });
      // Known on the drill host: the spike leftovers marked for review (C3), this
      // test's one-hour tokens, the heartbeat with no probe token, and the jobs of
      // the ops image, which knows staging and prod only (known-limits.md).
      const marked = data(state, "markedForReview") as {
        organizations: number;
        environments: number;
      };
      const review = String(marked.organizations + marked.environments);
      const known = [
        new RegExp(`^bad\\s+(checks\\.)?reviewOpen\\s+${review}\\s`),
        /^bad\s+checks\.credentialExpiring\s+\d+\s/,
        /^bad\s+checks\.unitsFailed\s+(mykey-(heartbeat|sweep|auth-cleanup)\.service(, )?)+\s/,
      ];
      const unexpected = status
        .split("\n")
        .filter((line) => line.startsWith("bad"))
        .filter((line) => !known.some((pattern) => pattern.test(line)));
      expect(unexpected).toEqual([]);
    },
    HOUR,
  );

  it(
    "after: the audit table holds restore_begin, restore_invalidate, restore_verify, gate_open in order; the owner reads P's rows",
    async () => {
      const state = readState();
      const actions = await hostSql(
        drillHost(),
        `SELECT action FROM audit.event
        WHERE action IN ('operator.restore_begin', 'operator.restore_invalidate', 'operator.restore_verify', 'operator.gate_open')
          AND occurred_at >= '${data(state, "lostAt") as string}'
        ORDER BY occurred_at, id`,
      );
      const first = [...new Set(actions)];
      expect(first).toEqual([
        "operator.restore_begin",
        "operator.restore_invalidate",
        "operator.restore_verify",
        "operator.gate_open",
      ]);
      const cookie = await drillOwnerSession();
      const pAtIso = data(state, "pairCapturedAt") as string;
      const audit = await call(
        DRILL,
        "GET",
        `${O}/audit?limit=10&to=${encodeURIComponent(pAtIso)}`,
        { cookie },
      );
      expect(audit.status, audit.body.slice(0, 200)).toBe(200);
      const items = (JSON.parse(audit.body) as { items: { occurredAt: string }[] }).items;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(Date.parse(item.occurredAt)).toBeLessThanOrEqual(Date.parse(pAtIso));
      }
    },
    HOUR,
  );

  // ------------------------------------------------------------ E: evidence, staging back
  it(
    "E: drill.json; the admin removed from the restored host; staging back in service",
    async () => {
      fence(false);
      await step("E-finish", async (state) => {
        const seeded = data(state, "seeded") as Seeded;
        // The restored memberships were P's: the admin removed after P is removed here too.
        await hostSql(
          drillHost(),
          `DELETE FROM app.membership WHERE user_id = '${seeded.admin.id}'`,
        );
        const lostAt = data(state, "lostAt") as string;
        const gateOpenedAt = data(state, "gateOpenedAt") as string;
        writeEvidence("docs/evidence/session-6/drill.json", {
          pairId: state.data.pairId,
          pairCapturedAt: state.data.pairCapturedAt,
          lostAt,
          steps: state.steps,
          gateOpenedAt,
          recoverySeconds: Math.round((Date.parse(gateOpenedAt) - Date.parse(lostAt)) / 1000),
          report: state.data.report,
          negative: state.data.negative,
          reconcile: state.data.reconcile,
          oldCredentials: state.data.oldCredentials,
          secrets: { count: seeded.secrets.length, revealedWithDigest: seeded.secrets.length },
          members: { confirmed: state.data.members, adminRemovedAfterOpening: true },
          freshPairId: null,
        });
        await hostTsOk(["staging", "resume"], { timeoutMs: 600_000 });
        await hostTsOk(["staging", "deploy", "--release", RELEASE], { timeoutMs: 2 * HOUR });
      });
      const status = await hostTsOk(["staging", "status"], { timeoutMs: 600_000 });
      expect(status.split("\n").filter((line) => line.startsWith("bad"))).toEqual([]);
    },
    3 * HOUR,
  );
});

// ------------------------------------------------------------------ helpers

/** The token of the newest reset link `ops reset-account` wrote (~/.mykey/out). */
function newestResetToken(): string {
  const out = join(homedir(), ".mykey", "out");
  const newest = readdirSync(out)
    .filter((name) => name.endsWith("-reset-link"))
    .sort()
    .at(-1);
  if (newest === undefined) throw new Error("no reset link in ~/.mykey/out");
  const token = /#t=([^&]+)/.exec(readFileSync(join(out, newest), "utf8"))?.[1]?.trim();
  if (token === undefined) throw new Error(`${newest} holds no token`);
  registerSecret(token);
  return token;
}

/** An admin of the staging organization, made the operator's way, signed in with TOTP (a fresh session). */
async function makeAdmin(): Promise<Seeded["admin"]> {
  const staging = await connectStaging();
  const superuser = createPool(
    {
      host: staging.pg.host,
      port: staging.pg.port,
      database: "postgres",
      user: "postgres",
      password: staging.pg.superuser.password,
      caCertPath: staging.pg.caCertPath,
    },
    { max: 2 },
  );
  try {
    const id = randomUUID();
    const email = `drill-admin-${id.slice(0, 6)}@mykey-staging.invalid`;
    const password = canary().toLowerCase();
    const auth = createAuth({ db: drizzle(superuser), keys: ephemeralKeys(), baseURL: STAGING });
    const hash = await (await auth.$context).password.hash(password);
    await superuser.query(
      `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, 'Drill admin', $2, true)`,
      [id, email],
    );
    await superuser.query(
      `INSERT INTO auth.account (id, account_id, provider_id, user_id, password)
       VALUES (gen_random_uuid(), $1, 'credential', $2, $3)`,
      [id, id, hash],
    );
    await superuser.query(
      "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
      [id],
    );
    await superuser.query(
      `INSERT INTO app.membership (id, organization_id, user_id, role, state)
       VALUES (gen_random_uuid(), $1, $2, 'admin', 'active')`,
      [ORG, id],
    );
    const signedIn = await call(STAGING, "POST", "/v1/auth/sign-in/email", {
      body: { email, password },
    });
    const passwordCookie = sessionOf(signedIn);
    const enrolled = await call(STAGING, "POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: passwordCookie,
    });
    const { secret } = JSON.parse(enrolled.body) as { secret: string };
    registerSecret(secret);
    const activated = await call(STAGING, "POST", "/v1/auth/totp/activate", {
      body: { code: codeAt(OTPAuth.Secret.fromBase32(secret).bytes, stepAt(new Date())) },
      cookie: passwordCookie,
    });
    expect(activated.status, activated.body).toBe(200);
    return { id, email, password, cookie: sessionOf(activated), totpSecret: secret };
  } finally {
    await superuser.end();
    await staging.close();
  }
}

/** The restored owner on the drill host, with the credentials its journey left in custody. */
async function drillOwnerSession(): Promise<string> {
  const dir = join(homedir(), ".mykey", "secrets", "hosts", "drill");
  const read = (name: string) => readFileSync(join(dir, name), "utf8").trim();
  const password = read("owner-password");
  const seed = read("owner-totp-seed");
  registerSecret(password);
  registerSecret(seed);
  const signedIn = await call(DRILL, "POST", "/v1/auth/sign-in/email", {
    body: { email: STAGING_OWNER_EMAIL, password },
  });
  expect(signedIn.status, signedIn.body).toBe(200);
  const lastFile = join(dir, "owner-totp-last-step");
  const last = existsSync(lastFile) ? Number(read("owner-totp-last-step")) : 0;
  while (stepAt(new Date()) <= last) await sleep(1_000);
  const stepNow = stepAt(new Date());
  writeFileSync(lastFile, `${String(stepNow)}\n`, { mode: 0o600 });
  const verified = await call(DRILL, "POST", "/v1/auth/totp/verify", {
    body: { code: codeAt(OTPAuth.Secret.fromBase32(seed).bytes, stepNow) },
    cookie: sessionOf(signedIn),
  });
  expect(verified.status, verified.body).toBe(200);
  return sessionOf(verified);
}
