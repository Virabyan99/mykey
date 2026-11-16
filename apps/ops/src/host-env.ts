// The ops image's settings on a host (Run 6.2, P-111): what ops-run.sh passes
// for a job. Plain settings come from the environment, secrets from the files
// it mounts; nothing secret is ever an environment value.
import { readFileSync } from "node:fs";
import { credentialsFromDirectory, r2Store } from "@mykey/backup";
import type { OpsEnv } from "./cli.ts";

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

/** The host a job runs on, as the archive names it. */
export const OPS_HOSTS = ["staging", "prod"] as const;
export type OpsHost = (typeof OPS_HOSTS)[number];

export interface HostJobEnv extends OpsEnv {
  host: OpsHost;
}

/** The OpsEnv of a job on a host. Throws MissingSetting naming the setting, never a value. */
export function opsEnvFromEnvironment(env: NodeJS.ProcessEnv): HostJobEnv {
  const port = Number(env.MYKEY_DB_PORT ?? "5432");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new MissingSetting("MYKEY_DB_PORT", "is not a port");
  }
  const host = required(env, "MYKEY_OPS_HOST");
  if (!(OPS_HOSTS as readonly string[]).includes(host)) {
    throw new MissingSetting("MYKEY_OPS_HOST", "is not staging or prod");
  }
  const passwordFile = required(env, "MYKEY_DB_PASSWORD_FILE");
  let password: string;
  try {
    password = readFileSync(passwordFile, "utf8").trim();
  } catch {
    throw new MissingSetting("MYKEY_DB_PASSWORD_FILE", "cannot be read");
  }
  if (password === "") throw new MissingSetting("MYKEY_DB_PASSWORD_FILE", "is empty");
  // Run 6.2 (P-112): the audit archive's bucket, for the job that names one.
  const bucket = env.MYKEY_AUDIT_BUCKET;
  let archive: OpsEnv["archive"];
  if (bucket !== undefined && bucket !== "") {
    let credentials;
    try {
      credentials = credentialsFromDirectory(required(env, "MYKEY_R2_DIR"));
    } catch (error) {
      if (error instanceof MissingSetting) throw error;
      throw new MissingSetting("MYKEY_R2_DIR", "does not hold the three credential files");
    }
    archive = {
      store: r2Store(credentials, bucket),
      host,
      rotatedDir: env.MYKEY_BAO_ROTATED_DIR ?? null,
    };
  }
  return {
    host: host as OpsHost,
    ...(archive === undefined ? {} : { archive }),
    database: {
      host: required(env, "MYKEY_DB_HOST"),
      port,
      database: env.MYKEY_DB_NAME ?? "postgres",
      user: required(env, "MYKEY_DB_USER"),
      password,
      caCertPath: required(env, "MYKEY_DB_CA_FILE"),
    },
  };
}
