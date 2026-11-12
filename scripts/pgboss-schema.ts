// Prints the SQL that creates pg-boss's objects in schema `jobs` for the pinned
// pg-boss version (Run 3.1). Migration 0004 holds this text verbatim.
// With --check it prints nothing and exits 1 when the migration no longer
// contains it — a pg-boss upgrade then needs a new migration, not an edit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jobSchemaSql } from "@mykey/operations";

export const JOB_SCHEMA_MIGRATION = resolve(
  import.meta.dirname,
  "../packages/db/migrations/0004_operator_and_jobs.sql",
);

if (import.meta.main) {
  const sql = jobSchemaSql();
  if (process.argv.includes("--check")) {
    const migration = readFileSync(JOB_SCHEMA_MIGRATION, "utf8").replaceAll("\r\n", "\n");
    if (!migration.includes(sql)) {
      console.error(
        "packages/db/migrations/0004_operator_and_jobs.sql does not contain the pg-boss schema of the pinned version.",
      );
      process.exit(1);
    }
    console.log("pg-boss schema in migration 0004 is current.");
  } else {
    process.stdout.write(sql);
  }
}
