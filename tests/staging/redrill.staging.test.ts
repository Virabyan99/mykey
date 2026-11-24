// Run 10.2 Task B / Run 10.6 (D-73, D-77; R4-2, R4-3, R4-4, R4-10, RR-1): the
// staging restore re-drill. Staging is restored onto its own reinstalled
// server, by restore.md, as production would be (R4-10's case). It is Run 6.8's
// drill (drill.staging.test.ts) re-aimed at staging itself, and it runs in
// three phases, each a run of this file with MYKEY_DRILL_TARGET=staging:
//
//   MYKEY_REDRILL_PHASE=before   B: the drill's content, the window's estimate, pair P, the changes after P
//                                (staging stays open)
//   MYKEY_REDRILL_PHASE=lost     B4: staging declared lost (gate closed, quiesced); R: "reinstall staging now"
//   MYKEY_REDRILL_PHASE=restore  C: restore.md's "Before" on the reinstalled server, the restore (timed,
//                                with the two-hour clock), the owner's return, the report; D: what stays
//                                closed; C9: the opening and what this session's fixes promise; E: redrill.json
//
// Every step records itself in ~/.mykey/drill/redrill-state.json (tokens and
// cookies live there only, 0600) and a rerun skips what is done. The owner's
// steps (the reinstall, the password, the tunnel, the KMS certificate) and the
// agent's first contact (bootstrap, apply, kms-install, kms-csr) happen between
// the phases `lost` and `restore`, by hand (Run 10.6 Task B).
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as OTPAuth from "otpauth";
import { codeAt, createAuth, ephemeralKeys, stepAt } from "@mykey/auth";
import { createPool } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { custodyCopyPath, datedCustodyCopies } from "../../scripts/host-custody.ts";
import {
  DRILL_DIR,
  drillTarget,
  hostSql,
  hostTs,
  hostTsOk,
  readState,
  requestAt,
  restoreClock,
  sessionOf,
  sha256,
  step,
  writeEvidence,
  writeState,
  type Answer,
  type DrillState,
} from "../harness/drill.ts";
import { connectStaging, loadHosts, registerSecret, sshExec } from "../harness/staging.ts";
import { STAGING_OWNER_EMAIL, readCustody, stagingOwnerSession } from "../harness/staging-owner.ts";

if (process.env.MYKEY_DRILL_TARGET !== "staging") {
  throw new Error("redrill.staging: set MYKEY_DRILL_TARGET=staging (its own state file)");
}
const PHASE = process.env.MYKEY_REDRILL_PHASE ?? "before";
if (!["before", "lost", "restore"].includes(PHASE)) {
  throw new Error("redrill.staging: MYKEY_REDRILL_PHASE is before, lost or restore");
}
const RELEASE = process.env.MYKEY_DRILL_RELEASE;
if (PHASE === "restore" && (RELEASE === undefined || RELEASE === "")) {
  throw new Error("redrill.staging: MYKEY_DRILL_RELEASE names the release staging runs");
}
/** Staging's new seal certificate (P-177): the one due by 5 Dec 2026. */
const SEAL = process.env.MYKEY_REDRILL_SEAL ?? "staging-seal-3";
const OKMS_TAR =
  process.env.MYKEY_OKMS_TAR ?? join(homedir(), "mykey-tmp", "okms-cli-linux-x86_64.tar.gz");

const H = "staging";
const host = drillTarget();
const STAGING = `https://${loadHosts().staging.hostname}`;
const SECRETS = 30;
const HOUR = 3_600_000;
/** Staging's OpenBao and KMS settings (kms-and-unseal.md), for host.env on the reinstalled server. */
const STAGING_OPENBAO_ENV: readonly (readonly [string, string])[] = [
  ["MYKEY_KMS_HOST", "us-east-vin.okms.ovh.us"],
  ["MYKEY_KMS_SEAL_KEY_ID", "5ec11f05-091a-460b-a7e6-f1064a6ece0e"],
  ["MYKEY_OPENBAO", "1"],
  ["MYKEY_BAO_URL", "https://openbao:8200"],
];
/** The pinned upstream images of the host's Compose file (postgres, openbao, traefik). */
const UPSTREAM_IMAGES = (["postgres", "openbao", "traefik"] as const).map((name) => {
  const pin = (
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "infra", "dependencies.lock.json"),
        "utf8",
      ),
    ) as {
      images: Record<string, { image: string; digest: string }>;
    }
  ).images[name];
  if (pin === undefined) throw new Error(`no pin for ${name}`);
  return `${pin.image}@${pin.digest}`;
});
/** Run 6.8: reconcile-credentials took about 19 s per environment. */
const RECONCILE_SECONDS = 19;

const journeyTarget = JSON.parse(
  readFileSync(join(homedir(), ".mykey", "secrets", "hosts", H, "deploy-journey.json"), "utf8"),
) as { organizationId: string };
const ORG = journeyTarget.organizationId;
const O = `/v1/organizations/${ORG}`;

const canary = (): string => {
  const value = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
  registerSecret(value);
  return value;
};

/** A request that waits out a rate limit (429), up to five times. */
async function call(
  method: string,
  path: string,
  init: Parameters<typeof requestAt>[3] = {},
): Promise<Answer> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await requestAt(STAGING, method, path, init);
    if (answer.status !== 429 || attempt === 5) return answer;
    await sleep(15_000);
  }
}

const idem = () => ({ "idempotency-key": randomUUID() });

function data(state: DrillState, key: string): unknown {
  const value = state.data[key];
  if (value === undefined) throw new Error(`redrill state has no ${key}`);
  return value;
}

/** Prints the restore's clock and refuses to go on with less than `needed` minutes. */
function clock(what: string, needed = 0): void {
  const { minutesLeft } = restoreClock(readState());
  if (minutesLeft === null) return;
  console.log(`redrill: ${what}: ${String(minutesLeft)} min left of the restore's 120 (RR-2)`);
  if (minutesLeft < needed) {
    throw new Error(`redrill: ${what} needs ${String(needed)} min; ${String(minutesLeft)} left`);
  }
}

interface Seeded {
  projectId: string;
  envs: { dev: string; second: string };
  secrets: { name: string; env: "dev" | "second"; sha256: string }[];
  liveToken: string;
  revokeToken: string;
  revokeCredentialId: string;
  admin: { id: string; email: string; password: string; cookie: string };
  ownerCookieAtP: string;
}

const envPath = (seeded: Seeded, env: "dev" | "second") =>
  `${O}/projects/${seeded.projectId}/environments/${seeded.envs[env]}`;

const gate = async (): Promise<{ state: string; phase?: string; origin?: { kind: string } }> =>
  JSON.parse((await sshExec(host, "cat /etc/mykey/gate/gate.json", { sudo: true })).stdout) as {
    state: string;
  };

describe("the staging restore re-drill onto its own server (D-73)", () => {
  // ------------------------------------------------------------------ B: before
  it(
    "B0: the window's estimate: active environments × 19 s + 30 min fits in 100 min",
    async () => {
      await step("B0-estimate", async (state) => {
        const [count = "0"] = await hostSql(
          host,
          "SELECT count(*) FROM app.environment WHERE state = 'active'",
        );
        const minutes = Math.ceil((Number(count) * RECONCILE_SECONDS) / 60) + 30;
        state.data.estimate = { environments: Number(count), minutes };
        expect(
          minutes,
          `${count} environments: archive old synthetic projects first (Run 10.6 Task A Step 2)`,
        ).toBeLessThanOrEqual(100);
      });
    },
    HOUR,
  );

  it(
    "B1: the drill's content: a project, two environments, 30 secrets, two tokens, an admin",
    async () => {
      await step("B1-seed", async (state) => {
        const { cookie } = await stagingOwnerSession();
        const created = await call("POST", `${O}/projects`, {
          body: { name: `Redrill ${randomUUID().slice(0, 6)}` },
          cookie,
          headers: idem(),
        });
        expect(created.status, created.body).toBe(201);
        const result = (
          JSON.parse(created.body) as {
            result: { projectId: string; developmentEnvironmentId: string };
          }
        ).result;
        const second = await call("POST", `${O}/projects/${result.projectId}/environments`, {
          body: { name: "drill" },
          cookie,
          headers: idem(),
        });
        expect(second.status, second.body).toBe(201);
        const secondId = (JSON.parse(second.body) as { result: { environmentId: string } }).result
          .environmentId;
        for (const deadline = Date.now() + 180_000; ;) {
          const states = await hostSql(
            host,
            `SELECT state FROM app.environment WHERE id IN ('${result.developmentEnvironmentId}', '${secondId}')`,
          );
          if (states.length === 2 && states.every((s) => s === "active")) break;
          if (Date.now() > deadline) throw new Error(`environments: ${states.join(",")}`);
          await sleep(2_000);
        }
        const seeded: Seeded = {
          projectId: result.projectId,
          envs: { dev: result.developmentEnvironmentId, second: secondId },
          secrets: [],
          liveToken: "",
          revokeToken: "",
          revokeCredentialId: "",
          admin: { id: "", email: "", password: "", cookie: "" },
          ownerCookieAtP: "",
        };
        for (let i = 1; i <= SECRETS; i += 1) {
          const env = i <= SECRETS / 2 ? "dev" : "second";
          const name = `REDRILL_${String(i).padStart(3, "0")}`;
          const value = canary();
          const written = await call("POST", `${envPath(seeded, env)}/secrets`, {
            body: { name, value },
            cookie,
            headers: idem(),
          });
          expect(written.status, `${name}: ${written.body}`).toBe(201);
          seeded.secrets.push({ name, env, sha256: sha256(value) });
        }
        for (const which of ["live", "revoke"] as const) {
          const issued = await call("POST", `${envPath(seeded, "dev")}/credentials`, {
            body: { name: `redrill-${which}`, ttlSeconds: 172_800 },
            cookie: (await stagingOwnerSession()).cookie,
            headers: idem(),
          });
          expect(issued.status, issued.body).toBe(201);
          const body = JSON.parse(issued.body) as {
            token: string;
            credential: { credentialId: string };
          };
          registerSecret(body.token);
          if (which === "live") seeded.liveToken = body.token;
          else {
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
          host,
          "SELECT coalesce(to_json(max(capture_started_at))#>>'{}', '') FROM app.backup_pair WHERE host = 'staging'",
        );
        await sshExec(host, `systemctl start --no-block ${unit}`, { sudo: true });
        await sleep(2_000);
        for (const deadline = Date.now() + 1_800_000; ;) {
          const shown = (
            await sshExec(host, `systemctl show -p ActiveState ${unit}`, { sudo: true })
          ).stdout;
          if (/ActiveState=(inactive|failed)/.test(shown)) break;
          if (Date.now() > deadline) throw new Error("the backup unit did not finish");
          await sleep(3_000);
        }
        const [row] = await hostSql(
          host,
          `SELECT id, validation_status, to_json(capture_started_at)#>>'{}' FROM app.backup_pair
          WHERE host = 'staging' ORDER BY capture_started_at DESC LIMIT 1`,
        );
        const [pairId = "", status = "", capturedAt = ""] = (row ?? "").split("|");
        expect(Date.parse(capturedAt) > Date.parse(before[0] ?? "1970-01-01T00:00:00Z")).toBe(true);
        expect(status).toBe("eligible");
        state.data.pairId = pairId;
        state.data.pairCapturedAt = new Date(capturedAt).toISOString();
      });
    },
    HOUR,
  );

  it(
    "B3: the changes after P: a token revoked, the admin removed, a secret created, a token issued",
    async () => {
      await step("B3-after-P", async (state) => {
        const seeded = data(state, "seeded") as Seeded;
        const passwordAtP = readCustody("owner-password");
        if (passwordAtP === null) throw new Error("no owner-password in custody");
        state.data.ownerPasswordAtP = passwordAtP;
        writeState(state);
        const { cookie } = await stagingOwnerSession();
        const revoked = await call(
          "POST",
          `${envPath(seeded, "dev")}/credentials/${seeded.revokeCredentialId}/revoke`,
          { body: { confirmed: true }, cookie, headers: idem() },
        );
        expect(revoked.status, revoked.body).toBe(200);
        await hostSql(host, `DELETE FROM app.membership WHERE user_id = '${seeded.admin.id}'`);
        const written = await call("POST", `${envPath(seeded, "dev")}/secrets`, {
          body: { name: "REDRILL_AFTER_P", value: canary() },
          cookie,
          headers: idem(),
        });
        expect(written.status, written.body).toBe(201);
        const issued = await call("POST", `${envPath(seeded, "dev")}/credentials`, {
          body: { name: "redrill-after-p", ttlSeconds: 172_800 },
          cookie: (await stagingOwnerSession()).cookie,
          headers: idem(),
        });
        expect(issued.status, issued.body).toBe(201);
        const token = (JSON.parse(issued.body) as { token: string }).token;
        registerSecret(token);
        state.data.afterPToken = token;
      });
    },
    HOUR,
  );

  // ---------------------------------------------------- B4, R: declared lost
  it.runIf(PHASE === "lost" || PHASE === "restore")(
    "B4: staging declared lost: gate closed, executors stopped (only after production is settled)",
    async () => {
      await step("B4-lost", async (state) => {
        await hostTsOk([H, "gate", "close"]);
        await hostTsOk([H, "quiesce"], { timeoutMs: 600_000 });
        // Run 10.6: a lost host makes no more pairs. quiesce stops the executors,
        // not the timers, and the 03:00 pair of the next night became the newest.
        const stopped = await sshExec(host, "systemctl stop mykey-backup.timer", { sudo: true });
        expect(stopped.code, stopped.stderr).toBe(0);
        state.data.lostAt = new Date().toISOString();
      });
      if (PHASE === "lost") {
        console.log(
          "redrill: staging is closed and quiesced. Reinstall staging now (Run 10.6 Task B), then MYKEY_REDRILL_PHASE=restore.",
        );
      }
    },
    HOUR,
  );

  // ------------------------------------------------- C: the reinstalled server
  it.runIf(PHASE === "restore")(
    "C1: restore.md's Before on the reinstalled server; closed",
    async () => {
      await step(
        "C1-install",
        async (state) => {
          await hostTsOk([H, "push"], { timeoutMs: 600_000 });
          await hostTsOk([H, "kms-install", OKMS_TAR]);
          // Run 10.6: a reinstalled server's host.env has none of OpenBao's settings
          // (production.md §2 sets them; restore.md's "Before" did not say so).
          for (const [key, value] of STAGING_OPENBAO_ENV) await hostTsOk([H, "env", key, value]);
          await hostTsOk([
            H,
            "kms-cert",
            SEAL,
            join(homedir(), ".mykey", "kms", `${SEAL}.crt`).replaceAll("\\", "/"),
          ]);
          await hostTsOk([H, "kms-use", SEAL]);
          await hostTsOk([H, "deploy", "--release", RELEASE ?? "", "--install-only"], {
            timeoutMs: 2 * HOUR,
          });
          // Run 10.6: by digest, not `compose pull`. Compose interpolates host.env,
          // which has no MYKEY_BASE_URL before the first `up` (production.md §1).
          for (const image of UPSTREAM_IMAGES) {
            await hostTsOk([H, "maint", "10", "--", "docker", "pull", "-q", image], {
              timeoutMs: 900_000,
            });
          }
          await hostTsOk(
            [
              H,
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
          await hostTsOk([H, "up"], { timeoutMs: 1_200_000 });
          // R4-10: the lost host's answer stays the custody copy; the new one goes beside it, dated.
          const custodyBefore = readFileSync(custodyCopyPath(H), "utf8");
          await hostTsOk([H, "bao-init"], { timeoutMs: 600_000 });
          expect(readFileSync(custodyCopyPath(H), "utf8")).toBe(custodyBefore);
          state.data.datedCopiesAfterInit = datedCustodyCopies(H).length;
          await hostTsOk([H, "db-init"], { timeoutMs: 600_000 });
          // The workstation's key rings, installed again (keys init creates only what is missing).
          await hostTsOk([H, "keys", "init"]);
          await hostTsOk([H, "acme", "production"]);
          await hostTsOk([H, "up"], { timeoutMs: 1_200_000 });
          await hostTsOk([H, "ops-secrets"]);
          await hostTsOk([H, "timers"]);
          const heartbeat = spawnSync(
            process.execPath,
            ["scripts/probe.ts", "secrets", "--host", H],
            { encoding: "utf8", timeout: 300_000 },
          );
          expect(heartbeat.status, heartbeat.stderr.slice(-400)).toBe(0);
          await hostTsOk([H, "quiesce"], { timeoutMs: 600_000 });
        },
        { timed: true },
      );
    },
    3 * HOUR,
  );

  it.runIf(PHASE === "restore")(
    "C2: restore steps 1–7 from R2: P picked as the newest, verified, restored, closed + verifying",
    async () => {
      await step(
        "C2-restore",
        async (state) => {
          // Run 10.6: never on a server whose install did not finish (the first
          // restore run started the clock after C1 had failed).
          expect(state.done, "C1-install is not done").toContain("C1-install");
          // The clock starts no later than the command: step 4 comes inside it.
          state.data.step4At = new Date().toISOString();
          writeState(state);
          const output = await hostTsOk(
            [H, "restore", "--source", H, "--newest", "--organization", ORG],
            { timeoutMs: 2 * HOUR },
          );
          expect(output).toContain(
            `pair ${data(state, "pairId") as string} restored; closed + verifying`,
          );
        },
        { timed: true },
      );
      clock("after steps 1–7");
      expect(await gate()).toMatchObject({ state: "closed", phase: "verifying" });
    },
    2 * HOUR,
  );

  it.runIf(PHASE === "restore")(
    "C3: the owner's return: the organization verified, every environment's credentials reconciled, the reset",
    async () => {
      await step(
        "C3-owner",
        async (state) => {
          await hostTsOk([H, "ops", "verify-organization", "--organization", ORG]);
          // Staging's pairs hold Session 2's member-less spike organizations (known-limits.md).
          const marked = await hostSql(
            host,
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
          const envs = await hostSql(host, "SELECT id FROM app.environment WHERE state = 'active'");
          const exits: Record<string, number> = {};
          const started = Date.now();
          for (const [index, env] of envs.entries()) {
            if (index % 10 === 0) clock(`reconcile ${String(index)}/${String(envs.length)}`, 20);
            const run = await hostTs([H, "ops", "reconcile-credentials", "--environment", env]);
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
        },
        { timed: true },
      );
    },
    2 * HOUR,
  );

  it.runIf(PHASE === "restore")(
    "C4: restore-verify --journey (staging only): every check ok",
    async () => {
      await step(
        "C4-report",
        async (state) => {
          clock("the report", 20);
          await hostTsOk([
            H,
            "ops",
            "reset-account",
            "--email",
            STAGING_OWNER_EMAIL,
            "--kind",
            "mfa",
          ]);
          const [members = "0"] = await hostSql(host, "SELECT count(*) FROM app.membership");
          state.data.members = Number(members);
          await hostTsOk([H, "restore-verify", "--confirm-members", members, "--journey"]);
        },
        { timed: true },
      );
    },
    HOUR,
  );

  // ------------------------------------------------------ D: what stays closed
  it.runIf(PHASE === "restore")(
    "D: refused before the opening — gate open without a report, with a stale one, with another incarnation's; the public listener quarantined",
    async () => {
      await step("D-negative", async (state) => {
        const reportFile = join(homedir(), ".mykey", "secrets", "hosts", H, "restore-report.json");
        const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
        const negative: { name: string; refused: boolean; cause: string }[] = [];
        const attempt = async (name: string, args: string[]) => {
          const run = await hostTs(args);
          const cause =
            run.output
              .split("\n")
              .filter((line) => /refused|needs|not eligible|error/i.test(line))
              .at(-1)
              ?.slice(0, 200) ?? "";
          negative.push({
            name,
            refused: run.code !== 0 && (await gate()).state === "closed",
            cause,
          });
        };
        await attempt("gate open without a report", [H, "gate", "open"]);
        const write = (name: string, changed: Record<string, unknown>) => {
          const file = join(DRILL_DIR, name);
          writeFileSync(file, JSON.stringify({ ...report, ...changed }, null, 2));
          return file;
        };
        await attempt("a report older than 30 minutes", [
          H,
          "gate",
          "open",
          "--report",
          write("redrill-stale-report.json", {
            createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
          }),
        ]);
        await attempt("the report of another incarnation", [
          H,
          "gate",
          "open",
          "--report",
          write("redrill-foreign-report.json", { backendIncarnation: randomUUID() }),
        ]);
        const publicAnswer = await requestAt(STAGING, "GET", "/v1/organizations");
        negative.push({
          name: "the public listener before the opening",
          refused: publicAnswer.status === 503 && publicAnswer.body.includes("quarantined"),
          cause: `HTTP ${String(publicAnswer.status)}`,
        });
        state.data.negative = negative;
        expect(negative.filter((n) => !n.refused)).toEqual([]);
      });
    },
    HOUR,
  );

  it.runIf(PHASE === "restore")(
    "C9: the opening: a fresh journey and report, gate open; R4-2, R4-4 and R4-10 as promised",
    async () => {
      await step(
        "C9-open",
        async (state) => {
          clock("the opening", 15);
          const custodyAtP = readFileSync(custodyCopyPath(H), "utf8");
          await hostTsOk([
            H,
            "ops",
            "reset-account",
            "--email",
            STAGING_OWNER_EMAIL,
            "--kind",
            "mfa",
          ]);
          const members = String(data(state, "members"));
          await hostTsOk([
            H,
            "restore-verify",
            "--confirm-members",
            members,
            "--journey",
            "--open",
          ]);
          state.data.gateOpenedAt = new Date().toISOString();
          const report = readFileSync(
            join(homedir(), ".mykey", "secrets", "hosts", H, "restore-report.json"),
            "utf8",
          );
          state.data.report = {
            sha256: sha256(report),
            checks: (JSON.parse(report) as { checks: { id: string; state: string }[] }).checks.map(
              (c) => ({ id: c.id, state: c.state }),
            ),
          };
          // R4-2: the custody copy now holds the next root token (P's answer, a new token).
          const custodyAfter = JSON.parse(readFileSync(custodyCopyPath(H), "utf8")) as {
            root_token: string;
            recovery_keys_base64: string[];
          };
          const before = JSON.parse(custodyAtP) as {
            root_token: string;
            recovery_keys_base64: string[];
          };
          registerSecret(custodyAfter.root_token);
          const fixes = {
            r4_2_newRootToken: custodyAfter.root_token !== before.root_token,
            r4_2_sameRecoveryKey:
              custodyAfter.recovery_keys_base64[0] === before.recovery_keys_base64[0],
            // R4-4: a finished restore leaves no state file.
            r4_4_stateFileGone:
              (
                await sshExec(host, "test -e /var/lib/mykey/restore-state.json; echo $?", {
                  sudo: true,
                })
              ).stdout.trim() === "1",
            // R4-10: the reinstalled server's own answer was kept beside it, dated.
            r4_10_datedCopies: datedCustodyCopies(H).length,
          };
          state.data.fixes = fixes;
          writeState(state);
          expect(fixes.r4_2_newRootToken).toBe(true);
          expect(fixes.r4_2_sameRecoveryKey).toBe(true);
          expect(fixes.r4_4_stateFileGone).toBe(true);
          expect(fixes.r4_10_datedCopies).toBeGreaterThanOrEqual(1);
          // R4-2: ops works with the new token after the opening.
          await hostTsOk([H, "ops", "verify-organization", "--organization", ORG]);
        },
        { timed: true },
      );
      expect(await gate()).toMatchObject({ state: "open", origin: { kind: "restore" } });
    },
    HOUR,
  );

  // ------------------------------------------------ after the opening
  it.runIf(PHASE === "restore")(
    "after: the 30 secrets reveal with their digests; the one written after P is absent",
    async () => {
      const seeded = data(readState(), "seeded") as Seeded;
      const { cookie } = await stagingOwnerSession();
      for (const secret of seeded.secrets) {
        const answer = await call(
          "POST",
          `${envPath(seeded, secret.env)}/secrets/${secret.name}/reveal`,
          { body: {}, cookie },
        );
        expect(answer.status, secret.name).toBe(200);
        expect(sha256((JSON.parse(answer.body) as { value: string }).value), secret.name).toBe(
          secret.sha256,
        );
      }
      const absent = await call(
        "POST",
        `${envPath(seeded, "dev")}/secrets/REDRILL_AFTER_P/reveal`,
        {
          body: {},
          cookie,
        },
      );
      expect(absent.status).toBe(404);
    },
    HOUR,
  );

  it.runIf(PHASE === "restore")(
    "after: the old credentials are refused — three machine tokens, two sessions, two passwords",
    async () => {
      const state = readState();
      const seeded = data(state, "seeded") as Seeded;
      const refused: Record<string, number> = {};
      const keys = (token: string) =>
        requestAt(
          STAGING,
          "GET",
          `/v1/machine/projects/${seeded.projectId}/environments/development/keys`,
          { headers: { authorization: `Bearer ${token}` } },
        );
      refused.token_live_at_P = (await keys(seeded.liveToken)).status;
      refused.token_revoked_after_P = (await keys(seeded.revokeToken)).status;
      refused.token_issued_after_P = (await keys(data(state, "afterPToken") as string)).status;
      refused.owner_session_at_P = (
        await requestAt(STAGING, "GET", "/v1/organizations", { cookie: seeded.ownerCookieAtP })
      ).status;
      refused.admin_session_at_P = (
        await requestAt(STAGING, "GET", "/v1/organizations", { cookie: seeded.admin.cookie })
      ).status;
      const signIn = async (email: string, password: string) => {
        const answer = await requestAt(STAGING, "POST", "/v1/auth/sign-in/email", {
          body: { email, password },
        });
        if (answer.status !== 200) return answer.status;
        return (await requestAt(STAGING, "GET", "/v1/organizations", { cookie: sessionOf(answer) }))
          .status;
      };
      refused.admin_password_at_P = await signIn(seeded.admin.email, seeded.admin.password);
      refused.owner_password_at_P = await signIn(
        STAGING_OWNER_EMAIL,
        data(state, "ownerPasswordAtP") as string,
      );
      state.data.oldCredentials = refused;
      writeState(state);
      for (const [name, status] of Object.entries(refused)) {
        expect([401, 403, 404], `${name}: ${String(status)}`).toContain(status);
      }
    },
    HOUR,
  );

  it.runIf(PHASE === "restore")(
    "after: a new token reads the environment through the machine route",
    async () => {
      const seeded = data(readState(), "seeded") as Seeded;
      const { cookie } = await stagingOwnerSession();
      const issued = await call("POST", `${envPath(seeded, "dev")}/credentials`, {
        body: { name: "redrill-restored", ttlSeconds: 3_600 },
        cookie,
        headers: idem(),
      });
      expect(issued.status, issued.body).toBe(201);
      const body = JSON.parse(issued.body) as {
        token: string;
        credential: { credentialId: string };
      };
      registerSecret(body.token);
      const resolved = await requestAt(
        STAGING,
        "POST",
        `/v1/machine/projects/${seeded.projectId}/environments/development/resolve`,
        { headers: { authorization: `Bearer ${body.token}` } },
      );
      expect(resolved.status, resolved.body.slice(0, 200)).toBe(200);
      const entries = (JSON.parse(resolved.body) as { entries: { name: string; value: string }[] })
        .entries;
      const digests = new Map(entries.map((e) => [e.name, sha256(e.value)]));
      for (const secret of seeded.secrets.filter((s) => s.env === "dev")) {
        expect(digests.get(secret.name), secret.name).toBe(secret.sha256);
      }
      const revoked = await call(
        "POST",
        `${envPath(seeded, "dev")}/credentials/${body.credential.credentialId}/revoke`,
        { body: { confirmed: true }, cookie, headers: idem() },
      );
      expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
    },
    HOUR,
  );

  it.runIf(PHASE === "restore")(
    "after: the audit holds restore_begin, restore_invalidate, restore_verify, gate_open in order",
    async () => {
      const actions = await hostSql(
        host,
        `SELECT action FROM audit.event
        WHERE action IN ('operator.restore_begin', 'operator.restore_invalidate', 'operator.restore_verify', 'operator.gate_open')
          AND occurred_at >= '${data(readState(), "lostAt") as string}'
        ORDER BY occurred_at, id`,
      );
      expect([...new Set(actions)]).toEqual([
        "operator.restore_begin",
        "operator.restore_invalidate",
        "operator.restore_verify",
        "operator.gate_open",
      ]);
    },
    HOUR,
  );

  // ------------------------------------------------------------ E: evidence
  it.runIf(PHASE === "restore")(
    "E: redrill.json; the admin removed again; a redeploy works with the new root token",
    async () => {
      await step("E-finish", async (state) => {
        const seeded = data(state, "seeded") as Seeded;
        await hostSql(host, `DELETE FROM app.membership WHERE user_id = '${seeded.admin.id}'`);
        // R4-2: a deploy reads OpenBao with the custody root token, now the new one.
        await hostTsOk([H, "deploy", "--release", RELEASE ?? ""], { timeoutMs: 2 * HOUR });
        const lostAt = data(state, "lostAt") as string;
        const step4At = data(state, "step4At") as string;
        const gateOpenedAt = data(state, "gateOpenedAt") as string;
        const minutes = (from: string, to: string) =>
          Math.round((Date.parse(to) - Date.parse(from)) / 6_000) / 10;
        writeEvidence("docs/evidence/session-10/redrill.json", {
          target: "staging onto its own reinstalled server (R4-10)",
          release: RELEASE?.split(/[\\/]/).at(-1),
          pairId: state.data.pairId,
          pairCapturedAt: state.data.pairCapturedAt,
          // Run 10.6: the pair the restore took, when it was not P (recorded by hand).
          restoredPairId: state.data.restoredPairId ?? state.data.pairId,
          restoredPairCapturedAt: state.data.restoredPairCapturedAt ?? state.data.pairCapturedAt,
          lostAt,
          step4At,
          gateOpenedAt,
          steps: state.steps,
          estimate: state.data.estimate,
          minutesLostToOpen: minutes(lostAt, gateOpenedAt),
          minutesStep4ToOpen: minutes(step4At, gateOpenedAt),
          windowMinutes: 120,
          reconcile: state.data.reconcile,
          markedForReview: state.data.markedForReview,
          report: state.data.report,
          negative: state.data.negative,
          oldCredentials: state.data.oldCredentials,
          fixes: state.data.fixes,
          secrets: { count: seeded.secrets.length, revealedWithDigest: seeded.secrets.length },
          members: { confirmed: state.data.members },
          run68: "docs/evidence/session-6/drill.json",
        });
      });
    },
    3 * HOUR,
  );
});

// ------------------------------------------------------------------ helpers

/** An admin of the staging organization, made the operator's way, signed in with TOTP. */
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
    const email = `redrill-admin-${id.slice(0, 6)}@mykey-staging.invalid`;
    const password = canary().toLowerCase();
    const auth = createAuth({ db: drizzle(superuser), keys: ephemeralKeys(), baseURL: STAGING });
    const hash = await (await auth.$context).password.hash(password);
    await superuser.query(
      `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, 'Redrill admin', $2, true)`,
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
    const signedIn = await call("POST", "/v1/auth/sign-in/email", { body: { email, password } });
    const passwordCookie = sessionOf(signedIn);
    const enrolled = await call("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: passwordCookie,
    });
    const { secret } = JSON.parse(enrolled.body) as { secret: string };
    registerSecret(secret);
    const activated = await call("POST", "/v1/auth/totp/activate", {
      body: { code: codeAt(OTPAuth.Secret.fromBase32(secret).bytes, stepAt(new Date())) },
      cookie: passwordCookie,
    });
    expect(activated.status, activated.body).toBe(200);
    return { id, email, password, cookie: sessionOf(activated) };
  } finally {
    await superuser.end();
    await staging.close();
  }
}
