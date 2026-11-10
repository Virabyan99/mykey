// Schemas that exist from the first migration but have no tables yet:
// `auth` (session library tables, Session 2) and `jobs` (queue tables, Session 2).
import { pgSchema } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");
export const jobsSchema = pgSchema("jobs");
