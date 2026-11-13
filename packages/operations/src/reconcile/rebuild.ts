// One index row rebuilt from the backend (Run 4.5, P-75). No metadata → the
// row is removed. Otherwise: the current version, the state from its deleted
// (or destroyed) flag, a fresh tag. A live current version is read once for
// its byte length; the value is dropped at once and nothing else of it is
// kept. A deleted one keeps the row's length when the version is unchanged
// and takes the largest value length otherwise (the next undelete writes the
// true length). A row that already says all this keeps its tag.
import { LIMITS, type OperationId } from "@mykey/contracts";
import {
  deleteIndexRow,
  lockIndexRow,
  newStateTag,
  writeIndexRow,
  type EnvironmentScope,
} from "@mykey/db";
import { secretPath, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";

/** OpenBao could not be read: nothing is decided from it. */
export class BackendUnreadable extends Error {
  constructor(kind: string) {
    super(`backend unreadable: ${kind}`);
    this.name = "BackendUnreadable";
  }
}

export async function rebuildKey(
  tx: pg.PoolClient,
  bao: OpenBaoClient,
  scope: EnvironmentScope,
  name: string,
  cause: OperationId | null,
): Promise<"written" | "removed" | "unchanged"> {
  const path = secretPath(scope.projectId, scope.environmentId, name);
  const row = await lockIndexRow(tx, scope, name);
  const metadata = await bao.kvMetadata(path);
  if (!metadata.ok) {
    if (metadata.kind !== "not_found") throw new BackendUnreadable(metadata.kind);
    if (row === null) return "unchanged";
    await deleteIndexRow(tx, scope, name);
    return "removed";
  }
  const version = metadata.data.currentVersion;
  const entry = metadata.data.versions[String(version)];
  const deleted = entry === undefined || entry.deleted || entry.destroyed;
  let bytes: number;
  if (deleted) {
    bytes =
      row !== null && row.currentVersion === version
        ? row.liveValueBytes
        : LIMITS.secret.valueMaxBytes;
  } else {
    const read = await bao.kvRead(path, version);
    if (!read.ok) throw new BackendUnreadable(read.kind);
    bytes = Buffer.byteLength(read.data.envelope.value, "utf8");
  }
  const state = deleted ? "deleted" : "live";
  if (
    row !== null &&
    row.state === state &&
    row.currentVersion === version &&
    row.liveValueBytes === bytes
  ) {
    return "unchanged";
  }
  await writeIndexRow(tx, scope, {
    name,
    currentVersion: version,
    stateTag: newStateTag(),
    state,
    liveValueBytes: bytes,
    lastOperationId: cause ?? row?.lastOperationId ?? null,
  });
  return "written";
}
