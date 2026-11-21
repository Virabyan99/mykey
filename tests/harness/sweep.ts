// Run 8.4 (P-152, D08-S44): the canary sweep's seed. As the staging owner,
// through the public name, every kind of secret the product handles is made
// and moved once — so that each surface of the host can then be searched for
// all of them. The needles stay in this process's memory and are registered
// as secrets (never printed); the surfaces are searched with countOnHost or,
// for what the workstation holds, in memory.
//
// The control is canary-shaped and upper case, as the needles are, and it is
// meant to be found: a project and a secret are named with it, and the request
// that made the secret is the control request id.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { registerSecret } from "./staging.ts";
import { machineRequest } from "./staging-machine.ts";
import {
  completeOwnerPasswordReset,
  initiateOwnerReset,
  publicRequest,
  readCustody,
  stagingOwnerSession,
  writeCustody,
  type PublicAnswer,
} from "./staging-owner.ts";

/** The staging owner's organization (Run 3.2). */
export const SWEEP_ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
export const SWEEP_ENVIRONMENT = "development";

export interface Needle {
  kind:
    | "value"
    | "machine_token"
    | "session"
    | "password"
    | "totp_seed"
    | "recovery_code"
    | "reset_token"
    | "root_token"
    | "backup_password"
    | "maintenance_password";
  value: string;
}

export interface SweepSeed {
  needles: Needle[];
  control: { secretName: string; projectName: string; requestId: string };
  startedAt: Date;
  projectId: string;
  environmentId: string;
}

/** A canary-shaped string, assembled at run time (CLAUDE.md: never a literal in a file). */
export const canaryShaped = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;

const cookieValue = (cookie: string): string => cookie.slice(cookie.indexOf("=") + 1);

/** The operator's secrets that rest on the workstation (custody), for the needles. */
function custodyNeedles(): Needle[] {
  const out: Needle[] = [];
  const init = join(homedir(), ".mykey", "custody", "staging", "openbao-init.json");
  if (!existsSync(init)) throw new Error("no staging openbao-init.json in custody");
  const root = (JSON.parse(readFileSync(init, "utf8")) as { root_token?: string }).root_token;
  if (typeof root !== "string" || root.length < 8) throw new Error("no root token in custody");
  out.push({ kind: "root_token", value: root });
  const backup = join(homedir(), ".mykey", "custody", "staging", "backup", "password");
  out.push({ kind: "backup_password", value: readFileSync(backup, "utf8").trim() });
  const maintenance = readCustody("maintenance");
  if (maintenance === null) throw new Error("no maintenance password in custody");
  out.push({ kind: "maintenance_password", value: maintenance });
  return out;
}

export async function seedAndExercise(): Promise<SweepSeed> {
  // Five seconds of margin for the hosts' clocks (chrony keeps them within one).
  const startedAt = new Date(Date.now() - 5000);
  const needles: Needle[] = [];
  const keep = (kind: Needle["kind"], value: string): string => {
    if (value.length < 8) throw new Error(`a ${kind} needle shorter than 8 bytes`);
    registerSecret(value);
    needles.push({ kind, value });
    return value;
  };
  const password = readCustody("owner-password");
  const seed = readCustody("owner-totp-seed");
  if (password === null || seed === null) throw new Error("no staging owner in custody");
  keep("password", password);
  keep("totp_seed", seed);
  for (const needle of custodyNeedles()) keep(needle.kind, needle.value);

  let { cookie } = await stagingOwnerSession();
  keep("session", cookieValue(cookie));
  const send = (method: string, path: string, body: unknown) =>
    publicRequest(method, path, {
      body,
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });

  const control = { secretName: canaryShaped(), projectName: canaryShaped(), requestId: "" };
  const created = await send("POST", `/v1/organizations/${SWEEP_ORGANIZATION}/projects`, {
    name: control.projectName,
  });
  if (created.status !== 201) throw new Error(`project create answered ${String(created.status)}`);
  const { projectId, developmentEnvironmentId: environmentId } = json(created).result as {
    projectId: string;
    developmentEnvironmentId: string;
  };
  const projectPath = `/v1/organizations/${SWEEP_ORGANIZATION}/projects/${projectId}`;
  const env = `${projectPath}/environments/${environmentId}`;
  for (const deadline = Date.now() + 180_000; ;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const all = (json(listed).environments ?? []) as { id: string; state: string }[];
    if (all.find((environment) => environment.id === environmentId)?.state === "active") break;
    if (Date.now() > deadline) throw new Error("the sweep's environment did not become active");
    await sleep(3000);
  }
  const expectOk = (answer: PublicAnswer, what: string): Record<string, unknown> => {
    if (answer.status >= 300) {
      const code = /"code":"([a-z_]+)"/.exec(answer.body)?.[1] ?? "none";
      throw new Error(`${what} answered ${String(answer.status)} ${code}`);
    }
    return json(answer);
  };

  // The control secret: its value is synthetic and not a needle; its name and request id are controls.
  const made = await send("POST", `${env}/secrets`, {
    name: control.secretName,
    value: `synthetic-${randomBytes(8).toString("hex")}`,
  });
  expectOk(made, "the control secret");
  control.requestId = made.headers.get("x-request-id") ?? "";
  if (control.requestId === "") throw new Error("no x-request-id on the control's answer");
  expectOk(await send("POST", `${env}/secrets/${control.secretName}/reveal`, {}), "control reveal");

  // Three secrets with canary values: created, updated, imported.
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  const createdName = `SWEEP_CREATED_${suffix}`;
  const updatedName = `SWEEP_UPDATED_${suffix}`;
  const importedName = `SWEEP_IMPORTED_${suffix}`;
  expectOk(
    await send("POST", `${env}/secrets`, {
      name: createdName,
      value: keep("value", canaryShaped()),
    }),
    "create",
  );
  const first = expectOk(
    await send("POST", `${env}/secrets`, {
      name: updatedName,
      value: keep("value", canaryShaped()),
    }),
    "create before update",
  ).result as { version: number; stateTag: string };
  expectOk(
    await send("PATCH", `${env}/secrets/${updatedName}`, {
      value: keep("value", canaryShaped()),
      expectedVersion: first.version,
      expectedStateTag: first.stateTag,
    }),
    "update",
  );
  const text = `${importedName}=${keep("value", canaryShaped())}\n`;
  const preview = await publicRequest("POST", `${env}/import/preview`, { text, cookie });
  const previewId = String(expectOk(preview, "import preview").previewId);
  let applied = await publicRequest("POST", `${env}/import/${previewId}/apply`, {
    text,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
  for (let waits = 0; applied.status === 202; waits += 1) {
    if (waits > 10) throw new Error("the import did not finish");
    const operationId = String(json(applied).operationId);
    applied = await publicRequest("POST", `${env}/import-operations/${operationId}/resume`, {
      text,
      cookie,
    });
  }
  expectOk(applied, "import apply");

  // Reveal, a historical reveal, an export.
  expectOk(await send("POST", `${env}/secrets/${createdName}/reveal`, {}), "reveal");
  expectOk(
    await send("POST", `${env}/secrets/${updatedName}/reveal`, { version: first.version }),
    "historical reveal",
  );
  ({ cookie } = await stagingOwnerSession());
  keep("session", cookieValue(cookie));
  // The export answers a dotenv attachment, never parsed here (its text holds the values).
  const exported = await send("POST", `${env}/export`, { confirmed: true });
  if (exported.status !== 200) throw new Error(`export answered ${String(exported.status)}`);

  // A machine token: issued, used once by resolve, revoked.
  const issued = expectOk(
    await send("POST", `${env}/credentials`, {
      name: `sweep-${suffix.toLowerCase()}`,
      ttlSeconds: 600,
    }),
    "issue",
  ) as { credential: { credentialId: string }; token: string };
  keep("machine_token", issued.token);
  const resolved = await machineRequest("resolve", projectId, SWEEP_ENVIRONMENT, issued.token);
  if (resolved.status !== 200) throw new Error(`resolve answered ${String(resolved.status)}`);
  expectOk(
    await send("POST", `${env}/credentials/${issued.credential.credentialId}/revoke`, {
      confirmed: true,
    }),
    "revoke",
  );

  // An operator reset of kind password, completed; the new password goes to custody.
  const reset = initiateOwnerReset("password");
  keep("reset_token", reset.token);
  keep("password", await completeOwnerPasswordReset(reset.token));

  // The recovery codes regenerated (a fresh TOTP session); they go to custody.
  ({ cookie } = await stagingOwnerSession());
  keep("session", cookieValue(cookie));
  const regenerated = await publicRequest("POST", "/v1/auth/recovery/regenerate", {
    body: {},
    cookie,
  });
  const { recoveryCodes } = expectOk(regenerated, "recovery regenerate") as {
    recoveryCodes: string[];
  };
  for (const code of recoveryCodes) keep("recovery_code", code);
  writeCustody("owner-recovery-codes", recoveryCodes.join("\n"));

  // Sign-out.
  expectOk(await publicRequest("POST", "/v1/auth/sign-out", { body: {}, cookie }), "sign-out");

  return { needles, control, startedAt, projectId, environmentId };
}

/** Counts needles in a text held on the workstation; only counts come back. */
export function countInText(
  text: string,
  needles: readonly Needle[],
): { found: number; kinds: string[] } {
  const kinds = new Set<string>();
  let found = 0;
  for (const needle of needles) {
    if (text.includes(needle.value)) {
      found += 1;
      kinds.add(needle.kind);
    }
  }
  return { found, kinds: [...kinds].sort() };
}

/** As countInText, over bytes: an audit segment can be larger than a string may be. */
export function countInBytes(
  bytes: Buffer,
  needles: readonly Needle[],
): { found: number; kinds: string[] } {
  const kinds = new Set<string>();
  let found = 0;
  for (const needle of needles) {
    if (bytes.includes(needle.value, 0, "utf8")) {
      found += 1;
      kinds.add(needle.kind);
    }
  }
  return { found, kinds: [...kinds].sort() };
}
