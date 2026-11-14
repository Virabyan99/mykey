// export.create (Run 4.9, P-79, Doc 06 §8, FR-1.37): the environment as a
// dotenv attachment. A fresh TOTP (the pipeline) and `{ confirmed: true }`;
// no operation is recorded. Inside the large-request gate, the complete read
// of Run 4.8 with `secret.export` as its audit row — committed before the
// bytes leave — then the canonical serialization. Every refusal is the JSON
// error envelope.
import { createHash } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { loaderWarnings, serializeDotenv } from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { readEnvironment } from "@mykey/operations";
import type { LargeGate } from "../large.ts";
import { ApiError, type Handler } from "../pipeline/context.ts";
import { readDeps, recheckOf, refusedOf } from "./secrets.ts";

/** The warnings header holds at most this much; above it, only the count (P-79). */
const WARNINGS_MAX_BYTES = 8192;
const FILE_NAME_MAX = 63;

/**
 * The environment's name as a file name: lower-cased, every character outside
 * `[a-z0-9-]` replaced by `-`, at most 63 characters; `environment` when empty.
 */
export function safeFileName(environmentName: string): string {
  const safe = environmentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .slice(0, FILE_NAME_MAX);
  return safe === "" ? "environment" : safe;
}

export function exportHeaders(
  environmentName: string,
  bytes: Uint8Array,
  warnings: readonly { name: string; loader: string; kind: string }[],
): Record<string, string> {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  let encoded = encode(warnings);
  if (encoded.length > WARNINGS_MAX_BYTES)
    encoded = encode({ truncated: true, count: warnings.length });
  return {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="mykey-${safeFileName(environmentName)}.env"`,
    "content-digest": `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
    "x-content-type-options": "nosniff",
    "mykey-export-warnings": encoded,
  };
}

export function exportCreateHandler(large: LargeGate): Handler {
  return (ctx, deps) =>
    large.run(async () => {
      const scope = ctx.scope as EnvironmentScope | null;
      const principal = ctx.principal;
      if (scope === null || principal === null) throw new ApiError("dependency_unavailable");
      const outcome = await readEnvironment(readDeps(deps), {
        scope,
        userId: principal.userId,
        routeId: ctx.route.id,
        requestId: ctx.requestId,
        recheck: recheckOf(ctx, principal.userId, scope),
        audit: async (tx, read) => {
          await appendAudit(tx, {
            action: "secret.export",
            actor: { kind: "user", id: principal.userId },
            source: "api",
            organizationId: scope.organizationId,
            target: { kind: "environment", id: scope.environmentId },
            outcome: "success",
            requestId: ctx.requestId,
            operationId: null,
            details: { names: read.names },
          });
        },
      });
      if (outcome.kind === "refused") refusedOf(outcome);
      const entries = outcome.read.entries;
      const bytes = serializeDotenv(entries);
      const warnings = loaderWarnings(entries).map(({ name, loader, reason }) => ({
        name,
        loader,
        kind: reason,
      }));
      const named = await deps.pool.query<{ name: string }>(
        "SELECT name FROM app.environment WHERE organization_id = $1 AND id = $2",
        [scope.organizationId, scope.environmentId],
      );
      return {
        status: 200,
        body: null,
        headers: exportHeaders(named.rows[0]?.name ?? "", bytes, warnings),
        raw: { bytes, contentType: "text/plain; charset=utf-8" },
      };
    });
}
