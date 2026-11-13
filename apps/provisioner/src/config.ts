// The provisioner's settings (Run 3.8): the database as provisioner_runtime,
// OpenBao, the directory of its delivered credential, the gate, and the sweep
// interval. Secrets are read from files, never from the environment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbTarget } from "@mykey/db";
import type { OpenBaoTarget } from "@mykey/openbao";

export interface ProvisionerConfig {
  database: DbTarget;
  openBao: OpenBaoTarget;
  /** `organization-id`, `provisioner-role-id`, `provisioner-secret-id` (ops provision-organization). */
  secretsDirectory: string;
  gatePath: string;
  hostInstanceId: string;
  sweepSeconds: number;
  /** Written after every sweep tick; the health check reads its time. */
  stateFile: string;
}

export class MissingSetting extends Error {
  readonly setting: string;
  constructor(setting: string, problem = "is not set") {
    super(`${setting} ${problem}`);
    this.setting = setting;
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(name);
  return value;
}

export const DEFAULT_SWEEP_SECONDS = 300;

export function configFromEnvironment(env: NodeJS.ProcessEnv): ProvisionerConfig {
  const port = Number(env.MYKEY_DB_PORT ?? "5432");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MissingSetting("MYKEY_DB_PORT", "is not a port");
  }
  const sweepSeconds = Number(env.MYKEY_SWEEP_SECONDS ?? String(DEFAULT_SWEEP_SECONDS));
  if (!Number.isInteger(sweepSeconds) || sweepSeconds < 1) {
    throw new MissingSetting("MYKEY_SWEEP_SECONDS", "is not a positive integer");
  }
  return {
    database: {
      host: required(env, "MYKEY_DB_HOST"),
      port,
      database: env.MYKEY_DB_NAME ?? "postgres",
      user: env.MYKEY_DB_USER ?? "provisioner_runtime",
      password: readFileSync(required(env, "MYKEY_DB_PASSWORD_FILE"), "utf8").trim(),
      caCertPath: required(env, "MYKEY_DB_CA_FILE"),
    },
    openBao: {
      url: required(env, "MYKEY_BAO_URL"),
      caCertPath: required(env, "MYKEY_BAO_CA_FILE"),
    },
    secretsDirectory: env.MYKEY_PROVISIONER_SECRETS_DIR ?? "/run/mykey/secrets",
    gatePath: required(env, "MYKEY_GATE_PATH"),
    hostInstanceId: required(env, "MYKEY_HOST_INSTANCE_ID"),
    sweepSeconds,
    stateFile: env.MYKEY_PROVISIONER_STATE_FILE ?? "/tmp/mykey-provisioner/last-sweep",
  };
}

/** The organization this host serves and the provisioner's credential, read afresh each time. */
export function readCredential(
  directory: string,
): { organizationId: string; roleId: string; secretId: string } | null {
  try {
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    return {
      organizationId: read("organization-id"),
      roleId: read("provisioner-role-id"),
      secretId: read("provisioner-secret-id"),
    };
  } catch {
    return null;
  }
}
