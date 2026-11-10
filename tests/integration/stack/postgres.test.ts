import { readFileSync } from "node:fs";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, getSharedStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await getSharedStack();
});

function client(database: string, ssl: pg.ClientConfig["ssl"]): pg.Client {
  return new pg.Client({
    host: stack.pg.host,
    port: stack.pg.port,
    database,
    user: stack.pg.superuser.user,
    password: stack.pg.superuser.password,
    ssl,
    connectionTimeoutMillis: 10_000,
  });
}

function verifiedTls(): pg.ClientConfig["ssl"] {
  return { ca: readFileSync(stack.pg.caCertPath, "utf8"), rejectUnauthorized: true };
}

describe("local PostgreSQL", () => {
  it("server is PostgreSQL 18", async () => {
    const db = client(stack.pg.database, verifiedTls());
    await db.connect();
    try {
      const result = await db.query<{ server_version_num: string }>("SHOW server_version_num");
      expect(result.rows[0]!.server_version_num).toMatch(/^18\d{4}$/);
    } finally {
      await db.end();
    }
  });

  it("TLS with CA verification succeeds", async () => {
    const db = client(stack.pg.database, verifiedTls());
    await db.connect();
    try {
      const result = await db.query<{ ssl: boolean; version: string }>(
        "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      expect(result.rows[0]!.ssl).toBe(true);
      expect(result.rows[0]!.version).toBe("TLSv1.3");
    } finally {
      await db.end();
    }
  });

  it("TLS against a different CA is rejected by the client", async () => {
    const otherCa = [
      "-----BEGIN CERTIFICATE-----",
      "MIIBhTCCASugAwIBAgIQIRi6zePL6mKjOipn+dNuaTAKBggqhkjOPQQDAjASMRAw",
      "DgYDVQQKEwdBY21lIENvMB4XDTE3MTAyMDE5NDMwNloXDTE4MTAyMDE5NDMwNlow",
      "EjEQMA4GA1UEChMHQWNtZSBDbzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABD0d",
      "7VNhbWvZLWPuj/RtHFjvtJBEwOkhbN/BnnE8rnZR8+sbwnc/KhCk3FhnpHZnQz7B",
      "5aETbbIgmuvewdjvSBSjYzBhMA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggr",
      "BgEFBQcDATAPBgNVHRMBAf8EBTADAQH/MCkGA1UdEQQiMCCCDmxvY2FsaG9zdDo1",
      "NDUzgg4xMjcuMC4wLjE6NTQ1MzAKBggqhkjOPQQDAgNIADBFAiEA2zpJEPQyz6/l",
      "Wf86aX6PepsntZv2GYlA5UpabfT2EZICICpJ5h/iI+i341gBmLiAFQOyTDT+/wQc",
      "6MF9+Yw1Yy0t",
      "-----END CERTIFICATE-----",
    ].join("\n");
    const db = client(stack.pg.database, { ca: otherCa, rejectUnauthorized: true });
    await expect(db.connect()).rejects.toThrow();
    await db.end().catch(() => undefined);
  });

  it("a connection without TLS is refused", async () => {
    const db = client(stack.pg.database, false);
    await expect(db.connect()).rejects.toMatchObject({ code: "28000" });
    await db.end().catch(() => undefined);
  });

  it("freshDatabase gives an empty database and drop removes it", async () => {
    const fresh = await freshDatabase(stack);
    expect(fresh.database).not.toBe(stack.pg.database);

    const inside = client(fresh.database, verifiedTls());
    await inside.connect();
    const tables = await inside.query(
      "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    expect(tables.rowCount).toBe(0);
    await inside.end();

    await fresh.drop();

    const admin = client(stack.pg.database, verifiedTls());
    await admin.connect();
    try {
      const left = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        fresh.database,
      ]);
      expect(left.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
