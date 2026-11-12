// The probe's state (Run 2.6). Heartbeat fields and evaluation fields are kept
// in separate rows, so a heartbeat that arrives while the minute's evaluation
// runs is never overwritten by it.
import { initialState, type AlertIntent, type Heartbeat, type HostState } from "./evaluate.ts";

export interface AlertRow {
  host: string;
  condition: string;
  kind: string;
  since: number;
  at: number;
  delivered: number;
}

export interface Store {
  load(host: string, nowMs: number): Promise<HostState>;
  saveHeartbeat(state: HostState, nowMs: number): Promise<void>;
  saveEvaluation(state: HostState, nowMs: number): Promise<void>;
  logAlert(alert: AlertIntent, atMs: number, delivered: boolean): Promise<void>;
  recentAlerts(host: string, limit: number): Promise<AlertRow[]>;
}

type HeartbeatPart = Pick<HostState, "lastHeartbeatAt" | "lastHeartbeat" | "reportedSince">;
type EvaluationPart = Pick<HostState, "knownSince" | "failingSince" | "open">;

const heartbeatPart = (state: HostState): HeartbeatPart => ({
  lastHeartbeatAt: state.lastHeartbeatAt,
  lastHeartbeat: state.lastHeartbeat,
  reportedSince: state.reportedSince,
});
const evaluationPart = (state: HostState): EvaluationPart => ({
  knownSince: state.knownSince,
  failingSince: state.failingSince,
  open: state.open,
});

function combine(
  host: string,
  nowMs: number,
  beat: HeartbeatPart | null,
  evaluation: EvaluationPart | null,
): HostState {
  return { ...initialState(host, nowMs), ...(evaluation ?? {}), ...(beat ?? {}) };
}

/** In memory: the unit tests' store. `writes` counts every change. */
export class MemoryStore implements Store {
  readonly heartbeats = new Map<string, HeartbeatPart>();
  readonly evaluations = new Map<string, EvaluationPart>();
  readonly alerts: AlertRow[] = [];
  writes = 0;

  load(host: string, nowMs: number): Promise<HostState> {
    return Promise.resolve(
      combine(host, nowMs, this.heartbeats.get(host) ?? null, this.evaluations.get(host) ?? null),
    );
  }
  saveHeartbeat(state: HostState): Promise<void> {
    this.writes += 1;
    this.heartbeats.set(state.host, heartbeatPart(state));
    return Promise.resolve();
  }
  saveEvaluation(state: HostState): Promise<void> {
    this.writes += 1;
    this.evaluations.set(state.host, evaluationPart(state));
    return Promise.resolve();
  }
  logAlert(alert: AlertIntent, atMs: number, delivered: boolean): Promise<void> {
    this.writes += 1;
    this.alerts.push({
      host: alert.host,
      condition: alert.condition,
      kind: alert.kind,
      since: alert.sinceMs,
      at: atMs,
      delivered: delivered ? 1 : 0,
    });
    return Promise.resolve();
  }
  recentAlerts(host: string, limit: number): Promise<AlertRow[]> {
    return Promise.resolve(
      this.alerts
        .filter((row) => row.host === host)
        .slice(-limit)
        .reverse(),
    );
  }
}

// The part of Cloudflare's D1 binding this store uses.
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}

export class D1Store implements Store {
  readonly #db: D1Database;
  constructor(db: D1Database) {
    this.#db = db;
  }

  async load(host: string, nowMs: number): Promise<HostState> {
    const beat = (await this.#db
      .prepare("SELECT json FROM heartbeat WHERE host = ?")
      .bind(host)
      .first()) as { json: string } | null;
    const evaluation = (await this.#db
      .prepare("SELECT json FROM host_state WHERE host = ?")
      .bind(host)
      .first()) as { json: string } | null;
    return combine(
      host,
      nowMs,
      beat === null ? null : (JSON.parse(beat.json) as HeartbeatPart),
      evaluation === null ? null : (JSON.parse(evaluation.json) as EvaluationPart),
    );
  }

  async saveHeartbeat(state: HostState, nowMs: number): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO heartbeat (host, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (host) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .bind(state.host, JSON.stringify(heartbeatPart(state)), nowMs)
      .run();
  }

  async saveEvaluation(state: HostState, nowMs: number): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO host_state (host, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (host) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .bind(state.host, JSON.stringify(evaluationPart(state)), nowMs)
      .run();
  }

  async logAlert(alert: AlertIntent, atMs: number, delivered: boolean): Promise<void> {
    await this.#db
      .prepare(
        "INSERT INTO alert_log (host, condition, kind, since, at, delivered) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(alert.host, alert.condition, alert.kind, alert.sinceMs, atMs, delivered ? 1 : 0)
      .run();
  }

  async recentAlerts(host: string, limit: number): Promise<AlertRow[]> {
    const rows = await this.#db
      .prepare(
        "SELECT host, condition, kind, since, at, delivered FROM alert_log WHERE host = ? ORDER BY id DESC LIMIT ?",
      )
      .bind(host, limit)
      .all();
    return rows.results as unknown as AlertRow[];
  }
}

export type { Heartbeat };
