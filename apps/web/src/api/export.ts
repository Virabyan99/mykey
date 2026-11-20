// export.create (FR-1.37): the environment as one dotenv file. The answer is
// not JSON, so it has its own reader. The file is handed to the page only when
// the whole answer was read: the number of bytes is the one the server
// announced and their SHA-256 is the one in `content-digest`. Anything less is
// "incomplete", and then the page has nothing to save. Like every route of
// SECRET_BEARING it is called from an event handler and never through a query.
import { ROUTES } from "@mykey/contracts";
import { z } from "zod";
import type { Failure } from "../errors/explain.ts";
import { failureFrom } from "./client.ts";

export interface ExportWarning {
  name: string;
  loader: string;
  kind: string;
}

export interface ExportedFile {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  /** Names another loader would read differently; null when there were too many to list. */
  warnings: ExportWarning[] | null;
  warningCount: number;
}

export type ExportResult =
  | { kind: "file"; file: ExportedFile }
  /** The answer was a file and it did not arrive whole. */
  | { kind: "incomplete" }
  | { kind: "failure"; failure: Failure };

const route = ROUTES.find((candidate) => candidate.id === "export.create");

const warningsSchema = z.union([
  z.array(z.looseObject({ name: z.string(), loader: z.string(), kind: z.string() })),
  z.looseObject({ truncated: z.literal(true), count: z.number().int().nonnegative() }),
]);

function decode(text: string): unknown {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const FILE_NAME = /filename="(mykey-[a-z0-9-]{1,63}\.env)"/;

export async function exportEnvironment(
  at: Readonly<Record<"org" | "project" | "env", string>>,
): Promise<ExportResult> {
  if (route === undefined) throw new Error("not a route of the contract: export.create");
  const path = route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
    encodeURIComponent(at[name as keyof typeof at]),
  );
  let response: Response;
  try {
    response = await fetch(path, {
      method: route.method,
      headers: { accept: "text/plain, application/json", "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { kind: "failure", failure: { kind: "transport", status: null } };
  }
  const isFile =
    response.status === 200 && response.headers.get("content-type")?.startsWith("text/plain");
  if (isFile !== true) {
    let json: unknown;
    try {
      json = JSON.parse(await response.text());
    } catch {
      json = undefined;
    }
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    return {
      kind: "failure",
      failure: failureFrom({
        status: response.status,
        json,
        requestId: response.headers.get("x-request-id"),
        retryAfterSeconds: Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
      }),
    };
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { kind: "incomplete" };
  }
  // The length is checked when the browser shows it; the digest always.
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) !== bytes.length) return { kind: "incomplete" };
  const digest = /^sha-256=:([A-Za-z0-9+/=]+):$/.exec(response.headers.get("content-digest") ?? "");
  if (digest === null) return { kind: "incomplete" };
  const actual = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (actual !== digest[1]) return { kind: "incomplete" };

  const named = FILE_NAME.exec(response.headers.get("content-disposition") ?? "");
  const parsed = warningsSchema.safeParse(
    decode(response.headers.get("mykey-export-warnings") ?? ""),
  );
  const listed = parsed.success && Array.isArray(parsed.data) ? parsed.data : null;
  return {
    kind: "file",
    file: {
      bytes,
      fileName: named?.[1] ?? "mykey-export.env",
      warnings:
        listed?.map(({ name, loader, kind }) => ({ name, loader, kind })) ??
        (parsed.success ? null : []),
      warningCount:
        listed?.length ?? (parsed.success && !Array.isArray(parsed.data) ? parsed.data.count : 0),
    },
  };
}
