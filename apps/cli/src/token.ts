// The machine token's one source (P-96, FR-1.46): SECRETS_MACHINE_TOKEN, or
// the whole of stdin with --token-stdin (keys and export only). Two sources,
// none, or a token of the wrong shape is a usage error that never repeats it.
// The token is kept in a variable named `token` and nowhere else.
import { LIMITS } from "@mykey/contracts";
import { CliError } from "./errors.ts";
import { MACHINE_TOKEN_VARIABLE } from "./identity.ts";

const SHAPE = /^[A-Za-z0-9._-]+$/;
/** Enough for the longest token, a line ending and one byte to see it is too long. */
const STDIN_CAP = LIMITS.body.bearerMaxBytes + 3;

async function readAll(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stdin) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      chunks.push(bytes);
      size += bytes.length;
      if (size > STDIN_CAP) break;
    }
  } finally {
    (stdin as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readToken(
  env: NodeJS.ProcessEnv,
  tokenStdin: boolean,
  /** null for `run`, whose stdin belongs to the child. */
  stdin: NodeJS.ReadableStream | null,
): Promise<string> {
  const fromEnv = env[MACHINE_TOKEN_VARIABLE];
  if (fromEnv !== undefined && tokenStdin) {
    throw new CliError(
      "usage",
      `give the token by ${MACHINE_TOKEN_VARIABLE} or by --token-stdin, not both`,
    );
  }
  if (fromEnv === undefined && !tokenStdin) {
    throw new CliError(
      "usage",
      `no machine token: set ${MACHINE_TOKEN_VARIABLE} or use --token-stdin`,
    );
  }
  let token = fromEnv ?? (stdin === null ? "" : await readAll(stdin));
  if (tokenStdin) {
    if (token.endsWith("\r\n")) token = token.slice(0, -2);
    else if (token.endsWith("\n")) token = token.slice(0, -1);
  }
  if (
    token === "" ||
    Buffer.byteLength(token, "utf8") > LIMITS.body.bearerMaxBytes ||
    !SHAPE.test(token)
  ) {
    throw new CliError(
      "usage",
      "the machine token is empty, too long, or has characters a token never has",
    );
  }
  return token;
}
