// The CLI's error model (P-96, Doc 04 §7): eight categories, each one exit
// code, and one line on stderr. A message is written by the CLI itself and
// never quotes input, a response body, a value or a token; the code and the
// request id come from a parsed error envelope only.

export type Category =
  | "usage"
  | "malformed"
  | "unavailable"
  | "export_target"
  | "capacity"
  | "incompatible"
  | "denied"
  | "unsupported";

export const EXIT: Readonly<Record<Category, number>> = Object.freeze({
  usage: 64,
  malformed: 65,
  unavailable: 69,
  export_target: 73,
  capacity: 75,
  incompatible: 76,
  denied: 77,
  unsupported: 78,
});

export class CliError extends Error {
  readonly category: Category;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(category: Category, text: string, from?: { code?: string; requestId?: string }) {
    // One line, whatever the caller wrote.
    super(text.replace(/[\r\n]+/g, " "));
    this.name = "CliError";
    this.category = category;
    this.code = from?.code ?? null;
    this.requestId = from?.requestId ?? null;
  }
}

/** The HTTP half of the category table (P-96). */
export function categoryOf(status: number, code: string | null): Category {
  if (status === 401 || status === 403 || status === 404) return "denied";
  if (status === 429 || status === 507) return "capacity";
  if (status === 503 && code === "busy") return "capacity";
  // The API refuses what this CLI sends: the two do not speak the same contract.
  if (status === 400) return "incompatible";
  return "unavailable";
}

export function formatError(error: CliError): string {
  return `secrets: ${error.category}: ${error.message} (code: ${error.code ?? "none"}, requestId: ${error.requestId ?? "none"})`;
}
