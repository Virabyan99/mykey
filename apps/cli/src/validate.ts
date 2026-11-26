// A machine response is used only when it is provably the whole body the API
// sent and the complete set it describes (P-96, FR-1.49, Review focus 4).
// Every failure is `malformed`, and no message quotes the body.
import {
  API_MAJOR,
  checkSecretName,
  machineExchangeBody,
  machineKeysBody,
  machineResolveBody,
} from "@mykey/contracts";
import type { z } from "zod";
import { CliError } from "./errors.ts";
import { hasTokenShape } from "./token.ts";

export type ExchangeBody = z.infer<typeof machineExchangeBody>;
export type ResolveBody = z.infer<typeof machineResolveBody>;
export type KeysBody = z.infer<typeof machineKeysBody>;

export interface ResponseHead {
  status: number;
  contentLength: string | undefined;
  contentType: string | undefined;
  contentEncoding: string | undefined;
}

const malformed = (text: string): CliError => new CliError("malformed", text);

function parsedJson(raw: Buffer, head: ResponseHead): unknown {
  if (head.status !== 200) throw malformed("the API answered a status other than 200");
  const media = head.contentType?.split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json") throw malformed("the answer is not JSON");
  if (head.contentEncoding !== undefined) throw malformed("the answer is encoded");
  if (head.contentLength === undefined || !/^(0|[1-9][0-9]*)$/.test(head.contentLength)) {
    throw malformed("the answer has no length");
  }
  if (Number(head.contentLength) !== raw.length) {
    throw malformed("the answer is shorter or longer than its length says");
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw malformed("the answer does not parse");
  }
}

function checkNames(names: readonly string[], count: number, apiMajor: number): void {
  if (apiMajor !== API_MAJOR) throw malformed("the answer is of another API version");
  if (count !== names.length) throw malformed("the answer's count disagrees with its entries");
  if (new Set(names).size !== names.length) throw malformed("the answer repeats a name");
  if (!names.every((name) => checkSecretName(name).ok)) {
    throw malformed("the answer holds a name the name rule does not allow");
  }
}

export function validateResolve(raw: Buffer, head: ResponseHead): ResolveBody {
  const parsed = machineResolveBody.safeParse(parsedJson(raw, head));
  if (!parsed.success) throw malformed("the answer is not a complete resolve body");
  const body = parsed.data;
  checkNames(
    body.entries.map((entry) => entry.name),
    body.count,
    body.apiMajor,
  );
  return body;
}

export function validateKeys(raw: Buffer, head: ResponseHead): KeysBody {
  const parsed = machineKeysBody.safeParse(parsedJson(raw, head));
  if (!parsed.success) throw malformed("the answer is not a complete keys body");
  const body = parsed.data;
  checkNames(body.names, body.count, body.apiMajor);
  return body;
}

/**
 * The answer of an exchange (Session 11, P-187). Its token becomes the next
 * request's bearer, so it must have a token's shape; no message repeats it.
 */
export function validateExchange(raw: Buffer, head: ResponseHead): ExchangeBody {
  const parsed = machineExchangeBody.safeParse(parsedJson(raw, head));
  if (!parsed.success) throw malformed("the answer is not an exchange body");
  const body = parsed.data;
  if (body.apiMajor !== API_MAJOR) throw malformed("the answer is of another API version");
  if (!hasTokenShape(body.token)) throw malformed("the answer's token is not a token");
  return body;
}
