// Deploys and operates the off-host probe Worker (Run 2.6, D-22) through the
// Cloudflare API with the session token (ruling R53: no wrangler).
//
//   node scripts/probe.ts deploy          D1 database + migration, modules, cron, custom domain
//   node scripts/probe.ts secrets         new heartbeat and read tokens: Worker secrets, host files, heartbeat timer
//   node scripts/probe.ts state <host>    the probe's view of a host (read token)
//
// Prints names, ids and statuses only; tokens travel in request bodies and on
// SSH stdin, never in arguments or output.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expectSuccess, loadHosts, registerSecret, sshExec } from "../tests/harness/staging.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WORKER = join(ROOT, "workers/probe");
const API = "https://api.cloudflare.com/client/v4";
const ZONE = "nomikey.com";
const SECRETS = join(homedir(), ".mykey", "secrets");

/** JSON with // comments and trailing commas (the wrangler.jsonc format). */
export function readJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text.charAt(index + 1);
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface WorkerConfig {
  name: string;
  compatibility_date: string;
  triggers: { crons: string[] };
  routes: { pattern: string; custom_domain: boolean }[];
  d1_databases: { binding: string; database_name: string; migrations_dir: string }[];
  vars: Record<string, string>;
}

function workerConfig(): WorkerConfig {
  return readJsonc(readFileSync(join(WORKER, "wrangler.jsonc"), "utf8")) as WorkerConfig;
}

function apiToken(): string {
  const token = readFileSync(join(SECRETS, "cloudflare", "session-2-token"), "utf8").trim();
  registerSecret(token);
  return token;
}

interface Envelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cf<T>(method: string, path: string, body?: FormData | string | object): Promise<T> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${apiToken()}` } };
  if (body instanceof FormData || typeof body === "string") init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const response = await fetch(`${API}${path}`, init);
  const envelope = (await response.json()) as Envelope<T>;
  if (!response.ok || !envelope.success) {
    const errors = envelope.errors.map((e) => `${e.code} ${e.message}`).join("; ");
    throw new Error(
      `${method} ${path.replace(/\/accounts\/[0-9a-f]+/, "/accounts/…")}: HTTP ${response.status} ${errors}`,
    );
  }
  return envelope.result;
}

async function zoneAndAccount(): Promise<{ zoneId: string; accountId: string }> {
  const zones = await cf<{ id: string; account: { id: string } }[]>("GET", `/zones?name=${ZONE}`);
  const zone = zones[0];
  if (zone === undefined) throw new Error(`zone ${ZONE} not visible to the token`);
  return { zoneId: zone.id, accountId: zone.account.id };
}

/** The Worker's modules: TypeScript with its types stripped, imports pointed at .js. */
export function bundleModules(directory: string = join(WORKER, "src")): Map<string, string> {
  const modules = new Map<string, string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
    const code = stripTypeScriptTypes(readFileSync(join(directory, file), "utf8"));
    modules.set(
      file.replace(/\.ts$/, ".js"),
      code.replace(/(from\s+"\.\/[a-z-]+)\.ts"/g, '$1.js"'),
    );
  }
  return modules;
}

async function d1Database(accountId: string, name: string): Promise<string> {
  const found = await cf<{ uuid: string; name: string }[]>(
    "GET",
    `/accounts/${accountId}/d1/database?name=${name}`,
  );
  const existing = found.find((db) => db.name === name);
  if (existing !== undefined) return existing.uuid;
  const created = await cf<{ uuid: string }>("POST", `/accounts/${accountId}/d1/database`, {
    name,
  });
  console.log(`d1: created ${name}`);
  return created.uuid;
}

async function migrate(accountId: string, databaseId: string, directory: string): Promise<void> {
  const query = (sql: string) =>
    cf<{ results: Record<string, unknown>[] }[]>(
      "POST",
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { sql },
    );
  const tables = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_log'",
  );
  if ((tables[0]?.results.length ?? 0) > 0) {
    console.log("d1: schema present");
    return;
  }
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await query(readFileSync(join(directory, file), "utf8"));
    console.log(`d1: applied ${file}`);
  }
}

/**
 * The sink-failure test Worker (Run 2.6 Step 4): the same code with its own
 * D1, watching a host that does not exist, alerting a webhook that answers
 * 404 (a path of the real probe). No custom domain; read through D1.
 */
function sinkTestConfig(): WorkerConfig {
  const base = workerConfig();
  const probeHost = base.routes[0]?.pattern ?? "";
  return {
    ...base,
    name: `${base.name}-sinktest`,
    routes: [],
    d1_databases: base.d1_databases.map((d1) => ({
      ...d1,
      database_name: `${d1.database_name}-sinktest`,
    })),
    vars: {
      ...base.vars,
      HOSTS: JSON.stringify([{ name: "nowhere", hostname: "mykey-nowhere.nomikey.com" }]),
      SINK: "webhook",
      WEBHOOK_URL: `https://${probeHost}/v1/sink-test`,
    },
  };
}

async function sinkTest(action: string | undefined): Promise<void> {
  const config = sinkTestConfig();
  const { accountId } = await zoneAndAccount();
  const d1Name = config.d1_databases[0]?.database_name ?? "";
  if (action === "up") {
    await deploy(config);
    return;
  }
  const found = await cf<{ uuid: string; name: string }[]>(
    "GET",
    `/accounts/${accountId}/d1/database?name=${d1Name}`,
  );
  const databaseId = found.find((db) => db.name === d1Name)?.uuid;
  if (action === "rows") {
    if (databaseId === undefined) throw new Error("no sink-test database");
    const query = async (sql: string) =>
      (
        await cf<{ results: Record<string, unknown>[] }[]>(
          "POST",
          `/accounts/${accountId}/d1/database/${databaseId}/query`,
          { sql },
        )
      )[0]?.results ?? [];
    console.log(
      JSON.stringify({
        state: await query("SELECT host, json, updated_at FROM host_state"),
        alerts: await query(
          "SELECT host, condition, kind, at, delivered FROM alert_log ORDER BY id",
        ),
      }),
    );
  } else if (action === "down") {
    await cf("DELETE", `/accounts/${accountId}/workers/scripts/${config.name}?force=true`);
    console.log(`worker: removed ${config.name}`);
    if (databaseId !== undefined) {
      await cf("DELETE", `/accounts/${accountId}/d1/database/${databaseId}`);
      console.log(`d1: removed ${d1Name}`);
    }
  } else throw new Error("sinktest needs up | rows | down");
}

async function deploy(config: WorkerConfig = workerConfig()): Promise<void> {
  const { zoneId, accountId } = await zoneAndAccount();
  const d1 = config.d1_databases[0];
  if (d1 === undefined) throw new Error("no d1 database in wrangler.jsonc");
  const databaseId = await d1Database(accountId, d1.database_name);
  await migrate(accountId, databaseId, join(WORKER, d1.migrations_dir));

  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "index.js",
      compatibility_date: config.compatibility_date,
      bindings: [
        { type: "d1", name: d1.binding, id: databaseId },
        ...Object.entries(config.vars).map(([name, text]) => ({ type: "plain_text", name, text })),
      ],
      keep_bindings: ["secret_text"],
    }),
  );
  for (const [name, code] of bundleModules()) {
    form.append(name, new Blob([code], { type: "application/javascript+module" }), name);
  }
  await cf("PUT", `/accounts/${accountId}/workers/scripts/${config.name}`, form);
  console.log(`worker: uploaded ${config.name}`);
  await cf(
    "PUT",
    `/accounts/${accountId}/workers/scripts/${config.name}/schedules`,
    config.triggers.crons.map((cron) => ({ cron })),
  );
  console.log(`worker: crons ${config.triggers.crons.join(", ")}`);
  for (const route of config.routes.filter((r) => r.custom_domain)) {
    await cf("PUT", `/accounts/${accountId}/workers/domains`, {
      hostname: route.pattern,
      service: config.name,
      zone_id: zoneId,
      environment: "production",
    });
    console.log(`worker: custom domain ${route.pattern}`);
  }
}

function localSecret(name: string, create: boolean): string {
  const file = join(SECRETS, "probe", name);
  if (!create && existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    registerSecret(value);
    return value;
  }
  const value = randomBytes(32).toString("base64url");
  registerSecret(value);
  mkdirSync(join(SECRETS, "probe"), { recursive: true, mode: 0o700 });
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
  return value;
}

async function putSecret(
  accountId: string,
  script: string,
  name: string,
  text: string,
): Promise<void> {
  await cf("PUT", `/accounts/${accountId}/workers/scripts/${script}/secrets`, {
    name,
    text,
    type: "secret_text",
  });
  console.log(`worker secret: ${name}`);
}

async function secrets(): Promise<void> {
  const config = workerConfig();
  const { accountId } = await zoneAndAccount();
  const hosts = loadHosts();
  const probeHost = config.routes[0]?.pattern;
  if (probeHost === undefined) throw new Error("no probe host name");
  const read = (path: string) => {
    const value = readFileSync(join(SECRETS, path), "utf8").trim();
    registerSecret(value);
    return value;
  };
  await putSecret(accountId, config.name, "READ_TOKEN", localSecret("read-token", true));
  await putSecret(accountId, config.name, "TELEGRAM_BOT_TOKEN", read("alerts/telegram-bot-token"));
  await putSecret(accountId, config.name, "TELEGRAM_CHAT_ID", read("alerts/telegram-chat-id"));
  for (const host of [hosts.staging, hosts.prod]) {
    const token = localSecret(`heartbeat-${host.name}`, true);
    await putSecret(accountId, config.name, `HEARTBEAT_TOKEN_${host.name.toUpperCase()}`, token);
    const curlConfig = `url = "https://${probeHost}/v1/heartbeat/${host.name}"\nheader = "Authorization: Bearer ${token}"\n`;
    const install = [
      "install -d -m 0700 -o root -g root /etc/mykey/secrets/heartbeat",
      "install -m 0600 -o root -g root /dev/stdin /etc/mykey/secrets/heartbeat/curl.conf",
    ].join(" && ");
    expectSuccess(
      await sshExec(host, install, { sudo: true, stdin: curlConfig, secretOutput: true }),
      `${host.name}: heartbeat config`,
    );
    const units = [
      "install -m 0644 /opt/mykey/hosts/systemd/mykey-heartbeat.service /opt/mykey/hosts/systemd/mykey-heartbeat.timer /etc/systemd/system/",
      "systemctl daemon-reload",
      "/opt/mykey/hosts/firewall/mykey-egress.sh refresh >/dev/null",
      "systemctl enable --now mykey-heartbeat.timer",
      "systemctl start mykey-heartbeat.service",
    ].join(" && ");
    expectSuccess(
      await sshExec(host, units, { sudo: true, timeoutMs: 60_000 }),
      `${host.name}: heartbeat timer`,
    );
    console.log(`${host.name}: heartbeat installed and sent`);
  }
}

async function state(host: string): Promise<void> {
  const config = workerConfig();
  const probeHost = config.routes[0]?.pattern;
  const token = localSecret("read-token", false);
  const response = await fetch(`https://${probeHost}/v1/state/${host}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`state ${host}: HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "deploy") await deploy();
    else if (command === "secrets") await secrets();
    else if (command === "state" && argument !== undefined) await state(argument);
    else if (command === "sinktest") await sinkTest(argument);
    else {
      console.error(
        "usage: node scripts/probe.ts deploy | secrets | state <host> | sinktest up|rows|down",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`probe.ts: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
