// drizzle-kit is used for one thing: `generate`, which writes SQL migrations
// from the schema files. Nothing here connects to a database; `push` is never used.
// `src/schema/meta.ts` is left out on purpose: the migrator owns schema `meta`.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema/app.ts", "./src/schema/audit.ts", "./src/schema/reserved.ts"],
  // scripts/db-check.ts points this at a temporary copy.
  out: process.env.MYKEY_DRIZZLE_OUT ?? "./migrations",
});
