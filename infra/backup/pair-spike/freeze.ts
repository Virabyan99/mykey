// THROW-AWAY (Run 2.9, P-36): the freeze around a paired capture. As
// `maintenance`, in one transaction: lock the service_control row, refuse
// unless idle, set `draining`, epoch + 1 and the pair id. Then wait until no
// effect slot is held and no operation is accepted or executing; an uncertain
// operation makes the pair impossible. Then `capturing`. Writers (the Run 2.4
// executor) refuse to admit anything while the mode is not idle.
import type pg from "pg";

export const DRAIN_DEADLINE_MS = 30_000;

export type FreezeResult =
  | { ok: true; epoch: string; frozenAt: number }
  | { ok: false; stage: "admission" | "drain"; reason: string };

export async function freeze(
  pool: pg.Pool,
  pairId: string,
  opts: { drainDeadlineMs?: number } = {},
): Promise<FreezeResult> {
  const client = await pool.connect();
  let epoch: string;
  try {
    await client.query("BEGIN");
    const control = await client.query<{ capture_mode: string; epoch: string }>(
      "SELECT capture_mode, epoch FROM app.service_control FOR UPDATE",
    );
    if (control.rows[0]?.capture_mode !== "idle") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        stage: "admission",
        reason: `capture mode is ${control.rows[0]?.capture_mode ?? "missing"}`,
      };
    }
    const updated = await client.query<{ epoch: string }>(
      `UPDATE app.service_control SET capture_mode = 'draining', epoch = epoch + 1, pair_id = $1,
              owner = 'pair-spike', updated_at = now()
        RETURNING epoch`,
      [pairId],
    );
    epoch = updated.rows[0]?.epoch ?? "";
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const deadline = Date.now() + (opts.drainDeadlineMs ?? DRAIN_DEADLINE_MS);
  for (;;) {
    const busy = await pool.query<{ slots: string; running: string; uncertain: string }>(
      `SELECT (SELECT count(*) FROM app.effect_slot) AS slots,
              (SELECT count(*) FROM app.operation WHERE state IN ('accepted', 'executing')) AS running,
              (SELECT count(*) FROM app.operation WHERE state = 'uncertain') AS uncertain`,
    );
    const row = busy.rows[0];
    if (row !== undefined && row.uncertain !== "0") {
      await release(pool);
      return { ok: false, stage: "drain", reason: `${row.uncertain} uncertain operation(s)` };
    }
    if (row?.slots === "0" && row.running === "0") break;
    if (Date.now() > deadline) {
      await release(pool);
      return {
        ok: false,
        stage: "drain",
        reason: "operations still running after the drain deadline",
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  await pool.query(
    "UPDATE app.service_control SET capture_mode = 'capturing', updated_at = now() WHERE capture_mode = 'draining'",
  );
  return { ok: true, epoch, frozenAt: Date.now() };
}

/** Back to idle; the pair id is cleared. */
export async function release(pool: pg.Pool): Promise<void> {
  await pool.query(
    "UPDATE app.service_control SET capture_mode = 'idle', pair_id = NULL, owner = NULL, updated_at = now()",
  );
}

/** The newest operation at the boundary, and what the manifest must show is not running. */
export async function boundaryOf(pool: pg.Pool): Promise<{
  lastOperationId: string | null;
  executingOperations: number;
  heldEffectSlots: number;
}> {
  const result = await pool.query<{ last: string | null; executing: string; slots: string }>(
    `SELECT (SELECT id FROM app.operation ORDER BY created_at DESC, id DESC LIMIT 1) AS last,
            (SELECT count(*) FROM app.operation WHERE state IN ('accepted', 'executing')) AS executing,
            (SELECT count(*) FROM app.effect_slot) AS slots`,
  );
  const row = result.rows[0];
  return {
    lastOperationId: row?.last ?? null,
    executingOperations: Number(row?.executing ?? 0),
    heldEffectSlots: Number(row?.slots ?? 0),
  };
}
