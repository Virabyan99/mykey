// The off-host probe (Run 2.6, D-22): a Cloudflare Worker that takes the
// hosts' heartbeats, probes their public /health every minute and sends
// alerts. Routes:
//   POST /v1/heartbeat/<host>  Bearer <the host's heartbeat token>  → 204
//   GET  /v1/state/<host>      Bearer <read token>                  → 200 JSON
// Everything else, an unknown host and a wrong token are 404.
import {
  evaluate,
  markDelivered,
  recordHeartbeat,
  type Heartbeat,
  type ProbeLimits,
} from "./evaluate.ts";
import { deliver, formatAlert, type SinkConfig } from "./sinks.ts";
import { D1Store, type D1Database, type Store } from "./store.ts";

export interface ProbeEnv {
  DB: D1Database;
  /** JSON: [{ name, hostname }]. */
  HOSTS: string;
  READ_TOKEN?: string;
  /** "telegram" (default) or "webhook". */
  SINK?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_URL?: string;
  HEARTBEAT_GRACE_SECONDS: string;
  HEALTH_GRACE_SECONDS: string;
  REPORTED_GRACE_SECONDS: string;
  REMINDER_SECONDS: string;
  /** HEARTBEAT_TOKEN_<HOST> for every host. */
  [secret: `HEARTBEAT_TOKEN_${string}`]: string | undefined;
}

interface HostEntry {
  name: string;
  hostname: string;
}

const notFound = (): Response => new Response("not found", { status: 404 });

function hostsOf(env: ProbeEnv): HostEntry[] {
  return JSON.parse(env.HOSTS) as HostEntry[];
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compares two secrets through their SHA-256 digests, in constant time. */
async function sameSecret(given: string, expected: string | undefined): Promise<boolean> {
  if (expected === undefined || expected.length < 16 || given === "") return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

const bearer = (request: Request): string =>
  /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";

function readHeartbeat(value: unknown): Heartbeat | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "bootId,kmsReachable,sealed") return null;
  const flag = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
  if (typeof record.bootId !== "string" || record.bootId.length > 64) return null;
  if (!flag(record.sealed) || !flag(record.kmsReachable)) return null;
  return { bootId: record.bootId, sealed: record.sealed, kmsReachable: record.kmsReachable };
}

export async function handleRequest(
  request: Request,
  env: ProbeEnv,
  store: Store,
  nowMs: number,
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/v1\/(heartbeat|state)\/([a-z0-9-]{1,32})$/.exec(url.pathname);
  if (match === null) return notFound();
  const [, route, host] = match as unknown as [string, string, string];
  if (!hostsOf(env).some((entry) => entry.name === host)) return notFound();

  if (route === "heartbeat" && request.method === "POST") {
    const token = env[`HEARTBEAT_TOKEN_${host.toUpperCase()}`];
    if (!(await sameSecret(bearer(request), token))) return notFound();
    let beat: Heartbeat | null;
    try {
      beat = readHeartbeat(JSON.parse(await request.text()));
    } catch {
      beat = null;
    }
    if (beat === null) return new Response("bad heartbeat", { status: 400 });
    // The Worker's clock, never the host's.
    await store.saveHeartbeat(recordHeartbeat(await store.load(host, nowMs), nowMs, beat), nowMs);
    return new Response(null, { status: 204 });
  }

  if (route === "state" && request.method === "GET") {
    if (!(await sameSecret(bearer(request), env.READ_TOKEN))) return notFound();
    const state = await store.load(host, nowMs);
    const alerts = await store.recentAlerts(host, 20);
    return Response.json({ now: nowMs, state, alerts });
  }
  return notFound();
}

function limitsOf(env: ProbeEnv): ProbeLimits {
  return {
    heartbeatGraceSeconds: Number(env.HEARTBEAT_GRACE_SECONDS),
    healthGraceSeconds: Number(env.HEALTH_GRACE_SECONDS),
    reportedGraceSeconds: Number(env.REPORTED_GRACE_SECONDS),
    reminderSeconds: Number(env.REMINDER_SECONDS),
  };
}

function sinkOf(env: ProbeEnv): SinkConfig {
  if (env.SINK === "webhook") return { kind: "webhook", url: env.WEBHOOK_URL ?? "" };
  return {
    kind: "telegram",
    botToken: env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: env.TELEGRAM_CHAT_ID ?? "",
  };
}

/** GET https://<hostname>/health: OK only for 200 and exactly {"status":"up"}. */
export async function probeHealth(
  hostname: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`https://${hostname}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200 && (await response.text()) === '{"status":"up"}';
  } catch {
    return false;
  }
}

/** One minute's evaluation of every host. */
export async function runEvaluation(env: ProbeEnv, store: Store, nowMs: number): Promise<void> {
  const limits = limitsOf(env);
  const sink = sinkOf(env);
  for (const host of hostsOf(env)) {
    const probeOk = await probeHealth(host.hostname);
    const state = await store.load(host.name, nowMs);
    const result = evaluate(nowMs, state, probeOk, limits);
    let next = result.next;
    for (const alert of result.alerts) {
      const delivered = await deliver(sink, formatAlert(alert));
      await store.logAlert(alert, nowMs, delivered);
      if (delivered) next = markDelivered(next, alert, nowMs);
    }
    await store.saveEvaluation(next, nowMs);
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    return handleRequest(request, env, new D1Store(env.DB), Date.now());
  },
  async scheduled(_controller: unknown, env: ProbeEnv): Promise<void> {
    await runEvaluation(env, new D1Store(env.DB), Date.now());
  },
};
