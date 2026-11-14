// A key's version history (Run 4.3, FR-1.26, P-73): OpenBao's metadata read
// once, the index's version events read once, joined. No lock and no value:
// metadata says when each version was made and whether it is deleted; the
// events say who made it. History judges no drift — a difference between the
// index and the backend is the business of the next writer under the lock.
import type { ErrorCode, OperationId } from "@mykey/contracts";
import {
  readIndexRow,
  versionEvents,
  type EnvironmentScope,
  type IndexState,
  type VersionEvent,
} from "@mykey/db";
import { secretPath } from "@mykey/openbao";
import type pg from "pg";
import type { RuntimeBao } from "../runtime.ts";
import { backendRefusal } from "./protocol.ts";

export const READ_FAULT_POINTS = ["after_backend_read", "before_audit_commit"] as const;
export type ReadFaultPoint = (typeof READ_FAULT_POINTS)[number];

export interface ReadDeps {
  pool: pg.Pool;
  lockPool: pg.Pool;
  bao: RuntimeBao;
  faults?: (point: ReadFaultPoint) => void | Promise<void>;
}

export interface Refused {
  kind: "refused";
  code: ErrorCode;
  operationId?: OperationId;
  details?: Record<string, unknown>;
}

interface Actor {
  kind: VersionEvent["actorKind"];
  id: string | null;
}

export interface HistoryVersion {
  version: number;
  createdAt: string;
  deleted: boolean;
  destroyed: boolean;
  current: boolean;
  written: {
    action: "create" | "update" | "restore" | null;
    actor: Actor;
    operationId: string | null;
  };
  lastChange: {
    action: "delete" | "undelete";
    actor: Actor;
    occurredAt: string;
    operationId: string | null;
  } | null;
}

export interface SecretHistory {
  name: string;
  currentVersion: number | null;
  state: IndexState;
  stateTag: string;
  versions: HistoryVersion[];
}

const WRITES: Record<string, "create" | "update" | "restore"> = {
  "secret.create": "create",
  "secret.update": "update",
  "secret.restore": "restore",
};
const CHANGES: Record<string, "delete" | "undelete"> = {
  "secret.delete": "delete",
  "secret.undelete": "undelete",
};

export async function readHistory(
  deps: ReadDeps,
  scope: EnvironmentScope,
  name: string,
  requestId: string,
): Promise<{ kind: "ok"; history: SecretHistory } | Refused> {
  const row = await readIndexRow(deps.pool, scope, name);
  if (row === null) return { kind: "refused", code: "not_found" };
  const bao = deps.bao.clientFor(scope.organizationId);
  if (bao === null) return { kind: "refused", code: "dependency_unavailable" };
  const metadata = await bao.kvMetadata(secretPath(scope.projectId, scope.environmentId, name));
  let entries: [number, { createdAt: string; deleted: boolean; destroyed: boolean }][] = [];
  let currentVersion: number | null = null;
  if (metadata.ok) {
    currentVersion = metadata.data.currentVersion;
    entries = Object.entries(metadata.data.versions).map(([key, entry]) => [Number(key), entry]);
  } else if (metadata.kind !== "not_found") {
    // A name in review may have no backend history at all (an uncertain create): not_found is an empty list.
    return { kind: "refused", code: await backendRefusal(deps.pool, scope, metadata, requestId) };
  }
  const events = await versionEvents(deps.pool, scope, name);
  const actorOf = (event: VersionEvent): Actor => ({ kind: event.actorKind, id: event.actorId });
  const versions = entries
    .sort(([a], [b]) => b - a)
    .map(([version, entry]): HistoryVersion => {
      const own = events.filter((event) => event.version === version);
      const written = own.find((event) => WRITES[event.action] !== undefined);
      const changes = own.filter((event) => CHANGES[event.action] !== undefined);
      const last = changes.at(-1);
      return {
        version,
        createdAt: new Date(entry.createdAt).toISOString(),
        deleted: entry.deleted,
        destroyed: entry.destroyed,
        current: version === currentVersion,
        written:
          written === undefined
            ? { action: null, actor: { kind: "unknown", id: null }, operationId: null }
            : {
                action: WRITES[written.action] ?? null,
                actor: actorOf(written),
                operationId: written.operationId,
              },
        lastChange:
          last === undefined
            ? null
            : {
                action: CHANGES[last.action] ?? "delete",
                actor: actorOf(last),
                occurredAt: last.occurredAt.toISOString(),
                operationId: last.operationId,
              },
      };
    });
  return {
    kind: "ok",
    history: {
      name,
      currentVersion: row.currentVersion,
      state: row.state,
      stateTag: row.stateTag,
      versions,
    },
  };
}
