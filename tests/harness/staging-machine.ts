// Machine access on staging (Run 5.4 Task D): requests with a bearer token to
// the public name, and what OpenBao on the host says about the accessors of
// some credentials. The accessors never leave the host: PostgreSQL's answer is
// piped into a short script run inside the API container, which logs in with
// the API's own issuer identity (bound to the API's address), looks each
// accessor up, revokes its session and prints status codes only.
import { createHash } from "node:crypto";
import { parseDotenv } from "@mykey/contracts";
import { expectSuccess, shQuote, sshExec, type HostEntry } from "./staging.ts";
import { publicRequest, type PublicAnswer } from "./staging-owner.ts";

export const digestOf = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** A machine route on the public name: the bearer and nothing else (no cookie). */
export function machineRequest(
  route: "keys" | "resolve",
  projectId: string,
  environmentName: string,
  token: string,
): Promise<PublicAnswer> {
  const path = `/v1/machine/projects/${projectId}/environments/${environmentName}/${route}`;
  return publicRequest(route === "keys" ? "GET" : "POST", path, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A resolve body as digests by name. */
export function resolvedDigests(answer: PublicAnswer): Map<string, string> {
  const body = JSON.parse(answer.body) as { entries?: { name: string; value: string }[] };
  return new Map((body.entries ?? []).map((entry) => [entry.name, digestOf(entry.value)]));
}

/** An export attachment as digests by name; throws unless it parses. */
export function exportedDigests(answer: PublicAnswer): Map<string, string> {
  const parsed = parseDotenv(answer.bytes);
  if (!parsed.ok) throw new Error("the export is not a dotenv file");
  return new Map(parsed.entries.map((entry) => [entry.name, digestOf(entry.value)]));
}

// Runs inside mykey-api-1 (node, ES module). Reads accessors from stdin, one a
// line; prints {"count":n,"statuses":[…]} and nothing else.
const LOOKUP = `
import { readFileSync } from "node:fs";
import https from "node:https";
const dir = process.env.MYKEY_API_SECRETS_DIR ?? "/run/mykey/secrets";
const read = (name) => readFileSync(dir + "/" + name, "utf8").trim();
const url = new URL(process.env.MYKEY_BAO_URL);
const ca = readFileSync(process.env.MYKEY_BAO_CA_FILE);
const namespace = "org-" + read("organization-id");
const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers = { "X-Vault-Namespace": namespace };
  if (token !== null) headers["X-Vault-Token"] = token;
  if (data !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
  const request = https.request({ hostname: url.hostname, port: url.port || 8200, path: "/v1/" + path, method, ca, headers }, (response) => {
    let text = "";
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, text }));
  });
  request.on("error", reject);
  if (data !== undefined) request.write(data);
  request.end();
});
let input = "";
for await (const chunk of process.stdin) input += chunk;
const accessors = input.split("\\n").map((line) => line.trim()).filter((line) => line !== "");
const login = await call("POST", "auth/approle/login", null, { role_id: read("issuer-role-id"), secret_id: read("issuer-secret-id") });
if (login.status !== 200) { console.log(JSON.stringify({ login: login.status })); process.exit(2); }
const token = JSON.parse(login.text).auth.client_token;
const statuses = [];
for (const accessor of accessors) statuses.push((await call("POST", "auth/token/lookup-accessor", token, { accessor })).status);
await call("POST", "auth/token/revoke-self", token);
console.log(JSON.stringify({ count: accessors.length, statuses }));
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What OpenBao on staging answers to a lookup of each credential's accessor
 * (200 alive, 400 gone), in credential id order. Only ids cross the command line.
 */
export async function accessorStatusesOnHost(
  host: HostEntry,
  credentialIds: string[],
): Promise<{ count: number; statuses: number[] }> {
  if (credentialIds.length === 0 || !credentialIds.every((id) => UUID.test(id))) {
    throw new Error("accessorStatusesOnHost needs credential ids");
  }
  const ids = credentialIds.map((id) => `'${id}'`).join(",");
  const query = `PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" psql -U postgres -d postgres -tA -c "SELECT accessor FROM app.machine_credential WHERE id IN (${ids}) AND accessor IS NOT NULL ORDER BY id"`;
  const script = Buffer.from(LOOKUP, "utf8").toString("base64");
  const command =
    `docker exec mykey-postgres-1 sh -c ${shQuote(query)}` +
    ` | docker exec -i mykey-api-1 node --input-type=module -e "$(printf %s ${script} | base64 -d)"`;
  const result = expectSuccess(
    await sshExec(host, command, { sudo: true, timeoutMs: 120_000 }),
    "accessor lookups on the host",
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as { count: number; statuses: number[] };
}
