// Raw OpenBao requests for tests that must send what the typed client refuses
// to build (hostile bodies, foreign namespaces, generic token creation), and
// the readers for their answers. Nothing here prints a body: answers hold
// tokens and accessors.
import { setTimeout as sleep } from "node:timers/promises";
import { baoFetch, type Stack } from "./stack.ts";

export interface BaoAnswer {
  status: number;
  /** The parsed JSON body; `{}` when there is none. */
  body: Record<string, unknown>;
}

/** One request below `/v1/`; `namespace: ""` is the root namespace. */
export async function baoAnswer(
  stack: Stack,
  token: string,
  method: string,
  path: string,
  opts: { namespace: string; body?: unknown },
): Promise<BaoAnswer> {
  const response = await baoFetch(stack, `/v1/${path}`, {
    method,
    token,
    ...(opts.namespace === "" ? {} : { namespace: opts.namespace }),
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  const text = await response.text();
  const body = text === "" ? null : (JSON.parse(text) as unknown);
  return { status: response.status, body: (body ?? {}) as Record<string, unknown> };
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.join(" | ") : "";
}

/** The error texts of an answer, joined; "" when there are none. */
export function errorsOf(answer: BaoAnswer): string {
  return joined(answer.body.errors);
}

/** The warning texts of an answer, joined; "" when there are none. */
export function warningsOf(answer: BaoAnswer): string {
  return joined(answer.body.warnings);
}

export function dataOf(answer: BaoAnswer): Record<string, unknown> {
  return (answer.body.data ?? {}) as Record<string, unknown>;
}

export interface BaoAuth {
  client_token: string;
  accessor: string;
  lease_duration: number;
}

export function authOf(answer: BaoAnswer): BaoAuth {
  const auth = answer.body.auth as BaoAuth | null | undefined;
  if (auth === null || auth === undefined) {
    throw new Error(`no auth in an answer with HTTP ${answer.status}`);
  }
  return auth;
}

/** Calls `probe` every 200 ms until it is true or `deadlineMs` has passed. */
export async function pollUntil(
  probe: () => Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}
