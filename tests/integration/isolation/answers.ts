// Run 8.2 (P-151): what "the same answer" means for the attack suite, and the
// paths of every route of ROUTES filled with one side's ids or random ones.
import { randomBytes, randomUUID } from "node:crypto";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { requestOf } from "../authz/requests.ts";
import type { Side } from "./fixture.ts";

export interface Seen {
  status: number;
  /** Header names, sorted. */
  headers: string[];
  /** The body with every request id replaced by a fixed string. */
  body: string;
  length: number;
}

const REQUEST_ID = /"requestId":"[0-9a-f-]{36}"/g;

export async function seen(response: Response): Promise<Seen> {
  const text = await response.text();
  return {
    status: response.status,
    headers: [...response.headers.keys()].map((name) => name.toLowerCase()).sort(),
    body: text.replace(REQUEST_ID, '"requestId":"-"'),
    length: Buffer.byteLength(text),
  };
}

/** Where two answers differ; empty when they are the same answer. */
export function differences(x: Seen, y: Seen): string[] {
  const out: string[] = [];
  if (x.status !== y.status) out.push(`status ${String(x.status)} ≠ ${String(y.status)}`);
  if (x.headers.join(",") !== y.headers.join(",")) {
    out.push(`headers ${x.headers.join(",")} ≠ ${y.headers.join(",")}`);
  }
  if (x.body !== y.body) out.push("body");
  if (x.length !== y.length) out.push(`length ${String(x.length)} ≠ ${String(y.length)}`);
  return out;
}

export interface PathValues {
  org: string;
  project: string;
  env: string;
  envName: string;
  name: string;
  preview: string;
  operation: string;
  credential: string;
}

export function idsOf(side: Side): PathValues {
  return {
    org: side.organizationId,
    project: side.ids.projectId,
    env: side.ids.environmentId,
    envName: side.ids.environmentName,
    name: side.ids.secretName,
    preview: side.ids.previewId,
    operation: side.ids.operationId,
    credential: side.ids.credentialId,
  };
}

/** Random values of the same shapes: ids nobody has, a secret name nobody has. */
export function randomIds(envName: string): PathValues {
  return {
    org: randomUUID(),
    project: randomUUID(),
    env: randomUUID(),
    envName,
    name: `ISO_R_${randomBytes(5).toString("hex").toUpperCase()}`,
    preview: randomUUID(),
    operation: randomUUID(),
    credential: randomUUID(),
  };
}

export function fill(route: RouteDef, values: PathValues): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name as keyof PathValues] as string | undefined;
    if (value === undefined) throw new Error(`no value for :${name} of ${route.id}`);
    return value;
  });
}

/** Every route a person's session sends that names an id in its path. */
export const humanRoutesWithIds = (): RouteDef[] =>
  ROUTES.filter(
    (route) =>
      (route.auth === "human" || route.auth === "human_fresh_totp") && route.path.includes(":"),
  );

/** One well-formed request of `route` to `path` as `cookie`. */
export function ask(side: Side, route: RouteDef, path: string, cookie: string): Promise<Response> {
  const { body, rawBody, headers } = requestOf(route);
  return side.request(route.method, path, {
    cookie,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(rawBody === undefined ? {} : { rawBody }),
  });
}
