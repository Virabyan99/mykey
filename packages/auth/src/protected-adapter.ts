// The database adapter Better Auth is given (P-26, D-19). It wraps the real
// adapter and changes only the `token` field of model `session`:
//
// - written values (`create`, `update` data) become `sessionVerifier(ring, token)`;
// - `token = x` and `token in [...]` become `token in` the verifiers of every key
//   of the ring, so a session made under a previous key still resolves;
// - a row found by token carries the raw token the caller supplied, so Better
//   Auth still builds its cookie from the raw value; a row found any other way
//   carries `token: ""`;
// - every other use of `token` (another operator, a sort, a count) throws.
//
// Every other model passes through untouched. The wrapper also wraps the
// adapter handed to `transaction` callbacks.
import type { BetterAuthOptions } from "better-auth";
import type { KeyRing } from "./keys.ts";
import { sessionVerifier, sessionVerifierCandidates } from "./session-verifier.ts";

export class UnsupportedTokenOperation extends Error {
  constructor(what: string) {
    super(`unsupported operation on session.token: ${what}`);
    this.name = "UnsupportedTokenOperation";
  }
}

interface Where {
  field: string;
  value: unknown;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: string;
}

type Row = Record<string, unknown>;
type Method = (args: Record<string, unknown>) => Promise<unknown>;
// The adapter as Better Auth hands it over: methods taking one argument object.
type AnyAdapter = Record<string, unknown>;

const SESSION = "session";
const TOKEN = "token";

/** Verifier → the raw token it was computed from, for the lookups of one call. */
type Lookup = Map<string, string>;

function rewriteWhere(
  ring: KeyRing,
  where: readonly Where[] | undefined,
): { where: Where[] | undefined; lookup: Lookup; byToken: boolean } {
  const lookup: Lookup = new Map();
  if (where === undefined) return { where, lookup, byToken: false };
  let byToken = false;
  const rewritten = where.map((clause) => {
    if (clause.field !== TOKEN) return clause;
    const operator = clause.operator ?? "eq";
    if (clause.mode !== undefined && clause.mode !== "sensitive") {
      throw new UnsupportedTokenOperation(`mode ${clause.mode}`);
    }
    let raws: string[];
    if (operator === "eq" && typeof clause.value === "string") raws = [clause.value];
    else if (
      operator === "in" &&
      Array.isArray(clause.value) &&
      clause.value.every((value) => typeof value === "string")
    )
      raws = clause.value;
    else throw new UnsupportedTokenOperation(`operator ${operator}`);
    byToken = true;
    const verifiers: string[] = [];
    for (const raw of raws) {
      for (const verifier of sessionVerifierCandidates(ring, raw)) {
        lookup.set(verifier, raw);
        verifiers.push(verifier);
      }
    }
    // A verifier is compared exactly; `mode` (case sensitivity) is dropped with the raw value.
    return {
      field: clause.field,
      value: verifiers,
      operator: "in",
      ...(clause.connector === undefined ? {} : { connector: clause.connector }),
    };
  });
  return { where: rewritten, lookup, byToken };
}

/** The row as the caller may see it: the raw token when found by token, otherwise none. */
function presentRow(row: unknown, lookup: Lookup, byToken: boolean): unknown {
  if (row === null || typeof row !== "object" || !(TOKEN in row)) return row;
  const stored = (row as Row)[TOKEN];
  const raw = byToken && typeof stored === "string" ? lookup.get(stored) : undefined;
  return { ...(row as Row), [TOKEN]: raw ?? "" };
}

function protectData(ring: KeyRing, data: unknown): { data: unknown; raw: string | undefined } {
  if (data === null || typeof data !== "object" || !(TOKEN in data)) {
    return { data, raw: undefined };
  }
  const raw = (data as Row)[TOKEN];
  if (typeof raw !== "string") throw new UnsupportedTokenOperation("a token that is not a string");
  return { data: { ...(data as Row), [TOKEN]: sessionVerifier(ring, raw) }, raw };
}

function wrap(adapter: AnyAdapter, ring: KeyRing): AnyAdapter {
  const call = (name: string): Method => {
    const method = adapter[name];
    if (typeof method !== "function") throw new Error(`the adapter has no method ${name}`);
    return (method as Method).bind(adapter);
  };
  const isSession = (args: Record<string, unknown>): boolean => args.model === SESSION;
  const wrapped: AnyAdapter = { ...adapter };

  wrapped.create = async (args: Record<string, unknown>) => {
    if (!isSession(args)) return call("create")(args);
    const { data, raw } = protectData(ring, args.data);
    const row = await call("create")({ ...args, data });
    if (raw === undefined) return presentRow(row, new Map(), false);
    const stored = (row as Row | null)?.[TOKEN];
    return presentRow(row, new Map([[String(stored), raw]]), true);
  };

  for (const name of ["findOne", "update", "consumeOne", "incrementOne"]) {
    if (typeof adapter[name] !== "function") continue;
    wrapped[name] = async (args: Record<string, unknown>) => {
      if (!isSession(args)) return call(name)(args);
      const { where, lookup, byToken } = rewriteWhere(ring, args.where as Where[] | undefined);
      const next: Record<string, unknown> = { ...args, where };
      if (name === "update") next.update = protectData(ring, args.update).data;
      if (name === "incrementOne" && args.set !== undefined) {
        next.set = protectData(ring, args.set).data;
      }
      return presentRow(await call(name)(next), lookup, byToken);
    };
  }

  wrapped.findMany = async (args: Record<string, unknown>) => {
    if (!isSession(args)) return call("findMany")(args);
    const sortBy = args.sortBy as { field?: string } | undefined;
    if (sortBy?.field === TOKEN) throw new UnsupportedTokenOperation("sort");
    const { where, lookup, byToken } = rewriteWhere(ring, args.where as Where[] | undefined);
    const rows = (await call("findMany")({ ...args, where })) as unknown[];
    return rows.map((row) => presentRow(row, lookup, byToken));
  };

  wrapped.count = async (args: Record<string, unknown>) => {
    if (isSession(args) && (args.where as Where[] | undefined)?.some((w) => w.field === TOKEN)) {
      throw new UnsupportedTokenOperation("count");
    }
    return call("count")(args);
  };

  for (const name of ["updateMany", "delete", "deleteMany"]) {
    wrapped[name] = async (args: Record<string, unknown>) => {
      if (!isSession(args)) return call(name)(args);
      const { where } = rewriteWhere(ring, args.where as Where[] | undefined);
      const next: Record<string, unknown> = { ...args, where };
      if (name === "updateMany") next.update = protectData(ring, args.update).data;
      return call(name)(next);
    };
  }

  wrapped.transaction = async (callback: (trx: AnyAdapter) => Promise<unknown>) =>
    call("transaction")(
      // The transaction adapter is handed to the callback, not passed as arguments.
      ((trx: AnyAdapter) => callback(wrap(trx, ring))) as unknown as Record<string, unknown>,
    );

  return wrapped;
}

/** Wraps an adapter factory such as `drizzleAdapter(db, …)`. */
export function protectedAdapter<A>(
  inner: (options: BetterAuthOptions) => A,
  ring: KeyRing,
): (options: BetterAuthOptions) => A {
  return (options) => wrap(inner(options) as AnyAdapter, ring) as A;
}
