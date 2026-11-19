// Run 6.5 Task B (P-118, P-120, Review focus 1): a paired capture of a local
// stack taken by the product's coordinator, and its restore into scratch
// instances. The database half goes into a new database on the stack's own
// PostgreSQL; the OpenBao half into the scratch OpenBao of
// scratch-bao.override.yml (same seal key), so the stack keeps serving.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "@mykey/db";
import { beginCapture, recordCapture, type Boundary } from "@mykey/operations/operator";
import type pg from "pg";
import {
  baoFetch,
  pgDumpToFile,
  pgGlobalsToFile,
  pgRestoreFromFile,
  scratchBao,
  type ScratchBao,
  type Stack,
} from "./stack.ts";

export interface PairSource {
  stack: Stack;
  /** The product database's name on the stack. */
  database: string;
  /** maintenance, on that database. */
  maintenance: pg.Pool;
  /** The superuser, on that database. */
  superuser: pg.Pool;
}

export interface TakenPair {
  pairId: string;
  captureStartedAt: Date;
  boundary: Boundary;
  directory: string;
  /** From the change to capturing until the release (ms). */
  frozenMs: number;
}

export interface RestoredPair {
  /** The superuser on the restored database. */
  db: pg.Pool;
  /** The scratch OpenBao, holding the restored snapshot (root token: the stack's). */
  bao: Stack;
  drop(): Promise<void>;
}

/**
 * One capture through the coordinator: begin, the three artifacts, record.
 * null when the coordinator answered busy (another capture, or the drain
 * did not finish in time).
 */
export async function takePair(source: PairSource, owner: string): Promise<TakenPair | null> {
  const begun = await beginCapture(source.maintenance, owner);
  if (begun.kind === "busy") return null;
  const started = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "mykey-pair-"));
  try {
    await pgDumpToFile(source.stack, source.database, join(directory, "postgres.dump"));
    await pgGlobalsToFile(source.stack, join(directory, "globals.sql"));
    const snapshot = await baoFetch(source.stack, "/v1/sys/storage/raft/snapshot");
    if (snapshot.status !== 200) throw new Error(`snapshot: HTTP ${String(snapshot.status)}`);
    writeFileSync(join(directory, "openbao.snap"), new Uint8Array(await snapshot.arrayBuffer()));
    await recordCapture(source.maintenance, begun.pairId, {
      host: "local",
      captureStartedAt: begun.captureStartedAt.toISOString(),
      boundary: begun.boundary,
      schemaRevision: "local",
      releaseBuild: "000000000000",
      keyRefs: { backupPassword: "local/1" },
      artifacts: [],
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    pairId: begun.pairId,
    captureStartedAt: begun.captureStartedAt,
    boundary: begun.boundary,
    directory,
    frozenMs: Date.now() - started,
  };
}

export interface PairRestorer {
  restore(pair: TakenPair): Promise<RestoredPair>;
}

/** The scratch OpenBao is initialised once; each restore replaces its state. */
export async function pairRestorer(source: PairSource): Promise<PairRestorer> {
  const scratch: ScratchBao = await scratchBao(source.stack);
  return {
    async restore(pair) {
      const name = `r_${randomBytes(6).toString("hex")}`;
      await source.superuser.query(`CREATE DATABASE ${name}`);
      await pgRestoreFromFile(source.stack, join(pair.directory, "postgres.dump"), name);
      await scratch.restore(new Uint8Array(readFileSync(join(pair.directory, "openbao.snap"))));
      const db = createPool(
        {
          host: source.stack.pg.host,
          port: source.stack.pg.port,
          database: name,
          caCertPath: source.stack.pg.caCertPath,
          ...source.stack.pg.superuser,
        },
        { max: 2 },
      );
      return {
        db,
        bao: scratch.stack,
        async drop() {
          await db.end();
          await source.superuser.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        },
      };
    },
  };
}
