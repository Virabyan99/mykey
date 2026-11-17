// Run 6.2 Task A (P-111): the ops image's settings. Secrets come from files,
// a missing or unreadable one is refused by name, and no error carries a value.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingSetting, opsEnvFromEnvironment } from "@mykey/ops";

const dir = mkdtempSync(join(tmpdir(), "mykey-ops-env-"));
const passwordFile = join(dir, "db-password");
const password = ["value", "of", "the", "role"].join("-");
writeFileSync(passwordFile, `${password}\n`);

const base = {
  MYKEY_OPS_HOST: "staging",
  MYKEY_DB_HOST: "postgres",
  MYKEY_DB_USER: "maintenance",
  MYKEY_DB_PASSWORD_FILE: passwordFile,
  MYKEY_DB_CA_FILE: "/run/mykey/tls/ca.crt",
};

describe("opsEnvFromEnvironment", () => {
  it("reads the database target, the password from its file, and the host", () => {
    const env = opsEnvFromEnvironment(base);
    expect(env.host).toBe("staging");
    expect(env.database).toEqual({
      host: "postgres",
      port: 5432,
      database: "postgres",
      user: "maintenance",
      password,
      caCertPath: "/run/mykey/tls/ca.crt",
    });
  });

  it("refuses a missing setting, an unknown host and an unreadable or empty password file, by name", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...base, MYKEY_OPS_HOST: "" }, /MYKEY_OPS_HOST is not set/],
      [{ ...base, MYKEY_OPS_HOST: "laptop" }, /MYKEY_OPS_HOST is not staging or prod/],
      [{ ...base, MYKEY_DB_USER: "" }, /MYKEY_DB_USER is not set/],
      [{ ...base, MYKEY_DB_PASSWORD_FILE: join(dir, "absent") }, /cannot be read/],
      [{ ...base, MYKEY_DB_PORT: "0" }, /MYKEY_DB_PORT is not a port/],
    ];
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    cases.push([{ ...base, MYKEY_DB_PASSWORD_FILE: empty }, /is empty/]);
    for (const [env, message] of cases) {
      let caught: unknown;
      try {
        opsEnvFromEnvironment(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MissingSetting);
      expect((caught as Error).message).toMatch(message);
      expect((caught as Error).message).not.toContain(password);
    }
  });

  it("the retention job (Run 6.6) gets the host's pairs bucket without a signer; without its R2 files it is refused by name", () => {
    const r2 = mkdtempSync(join(tmpdir(), "mykey-ops-r2-"));
    for (const name of ["account-id", "access-key-id", "secret-access-key"]) {
      writeFileSync(join(r2, name), `synthetic-${name}\n`);
    }
    const env = opsEnvFromEnvironment({ ...base, MYKEY_PAIR_RETENTION: "yes", MYKEY_R2_DIR: r2 });
    expect(env.pairs?.host).toBe("staging");
    expect(env.pairs?.signing).toBeUndefined();
    expect(env.pairs?.store).toBeDefined();
    expect(opsEnvFromEnvironment(base).pairs).toBeUndefined();
    expect(() =>
      opsEnvFromEnvironment({ ...base, MYKEY_PAIR_RETENTION: "yes", MYKEY_R2_DIR: join(dir, "x") }),
    ).toThrow(/MYKEY_R2_DIR/);
  });
});
