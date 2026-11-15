// GET /check: the names of FIXTURE_NAMES (comma-separated) that are set in
// this process's environment, and the SHA-256 of each value. Never a value.
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export function GET() {
  const wanted = (process.env.FIXTURE_NAMES ?? "").split(",").filter((name) => name !== "");
  const names = wanted.filter((name) => process.env[name] !== undefined);
  const digests = {};
  for (const name of names) {
    digests[name] = createHash("sha256").update(process.env[name], "utf8").digest("hex");
  }
  return Response.json({ names, digests });
}
