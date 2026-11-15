// Run 5.6 Task B (FR-1.50, AC-1.21): `secrets export` writes one new private
// file holding the complete set, or nothing. Values are synthetic and compared
// by digest after the codec's own parser read the file back.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "@mykey/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, startCli } from "../harness/cli.ts";
import {
  ENV_NAME,
  PROJECT,
  errorReply,
  goodResolve,
  startCliServer,
  type CliServer,
  type ServerScript,
} from "./server.ts";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const token = (): string => `s.${randomBytes(18).toString("base64url")}`;
const synthetic = (label: string): string => `synthetic-${label}-${randomBytes(6).toString("hex")}`;

let base: string;
let home: string;
let tmp: string;
let out: string;
const servers: CliServer[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mykey-export-")));
  home = join(base, "home");
  tmp = join(base, "tmp");
  out = join(base, "out");
  for (const dir of [home, tmp, out]) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(base, { recursive: true, force: true });
});

async function serve(script: ServerScript = {}): Promise<CliServer> {
  const server = await startCliServer(script);
  servers.push(server);
  return server;
}

const envOf = (server: CliServer, extra: Record<string, string> = {}): Record<string, string> => ({
  SECRETS_API_URL: server.url,
  NODE_EXTRA_CA_CERTS: server.caPath,
  SECRETS_MACHINE_TOKEN: token(),
  HOME: home,
  TMPDIR: tmp,
  ...extra,
});
const exportArgs = (target: string): string[] => [
  "export",
  "--project",
  PROJECT,
  "--env",
  ENV_NAME,
  "--output",
  target,
];

const entries = [
  { name: "DATABASE_URL", value: synthetic("db") },
  { name: "QUOTED", value: `say "hi"\nand\tgo \\ ${synthetic("q")}` },
  { name: "EMPTY", value: "" },
];

function digestsOfFile(path: string): Map<string, string> {
  const parsed = parseDotenv(readFileSync(path));
  if (!parsed.ok) throw new Error("the exported file does not parse");
  return new Map(parsed.entries.map((entry) => [entry.name, sha(entry.value)]));
}

const expected = new Map(entries.map((entry) => [entry.name, sha(entry.value)]));

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** The CLI under `sh -c 'umask <mask>; exec "$@"'` (the token stays in the environment). */
function withUmask(mask: string, args: string[], env: Record<string, string>) {
  return startCli(args, {
    env,
    through: (cli) => ["sh", ["-c", `umask ${mask}; exec "$@"`, "sh", ...cli]],
  }).result;
}

describe("secrets export", () => {
  it("a new file of mode 0600 whose parsed names and digests are the set; the plaintext warning on stderr", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const target = join(out, "app.env");
    const result = await runCli(exportArgs(target), { env: envOf(server) });
    expect(result.code, result.stderr).toBe(0);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(digestsOfFile(target)).toEqual(expected);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `secrets: ${target} holds plaintext secrets; protect it and delete it when done\n`,
    );
    // The values are in no other file under HOME and TMPDIR.
    for (const file of [...filesUnder(home), ...filesUnder(tmp)]) {
      const text = readFileSync(file, "utf8");
      expect(
        entries.some((entry) => entry.value !== "" && text.includes(entry.value)),
        file,
      ).toBe(false);
    }
  });

  it("an existing file → 73 and its bytes are unchanged", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const target = join(out, "app.env");
    writeFileSync(target, "KEEP=me\n", { mode: 0o600 });
    const result = await runCli(exportArgs(target), { env: envOf(server) });
    expect(result.code).toBe(73);
    expect(readFileSync(target, "utf8")).toBe("KEEP=me\n");
  });

  it("a symbolic link at the target → 73 and its target is untouched", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const victim = join(base, "victim");
    writeFileSync(victim, "untouched\n");
    const link = join(out, "app.env");
    symlinkSync(victim, link);
    const dangling = join(out, "dangling.env");
    symlinkSync(join(base, "nothing-here"), dangling);
    expect((await runCli(exportArgs(link), { env: envOf(server) })).code).toBe(73);
    expect((await runCli(exportArgs(dangling), { env: envOf(server) })).code).toBe(73);
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(existsSync(join(base, "nothing-here"))).toBe(false);
  });

  it("a symbolic link in the directory's path → 73", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const linked = join(base, "linked");
    symlinkSync(out, linked);
    const result = await runCli(exportArgs(join(linked, "app.env")), { env: envOf(server) });
    expect(result.code).toBe(73);
    expect(readdirSync(out)).toEqual([]);
  });

  it("a directory writable by group → 73", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    chmodSync(out, 0o770);
    const result = await runCli(exportArgs(join(out, "app.env")), { env: envOf(server) });
    expect(result.code).toBe(73);
    expect(readdirSync(out)).toEqual([]);
  });

  it("umask 000: the file is still 0600; umask 277: the export succeeds and the file is 0400", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const open = join(out, "open.env");
    const first = await withUmask("000", exportArgs(open), envOf(server));
    expect(first.code, first.stderr).toBe(0);
    expect(statSync(open).mode & 0o777).toBe(0o600);
    const strict = join(out, "strict.env");
    const second = await withUmask("277", exportArgs(strict), envOf(server));
    expect(second.code, second.stderr).toBe(0);
    expect(statSync(strict).mode & 0o777).toBe(0o400);
    expect(digestsOfFile(strict)).toEqual(expected);
  });

  it("an incomplete response creates no file", async () => {
    const good = goodResolve(entries);
    const whole = Buffer.from(JSON.stringify(good), "utf8");
    for (const [label, script] of [
      ["count wrong", { resolve: { status: 200, body: { ...good, count: 9 } } }],
      [
        "closed early",
        {
          resolve: {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(whole.length + 9),
            },
            body: whole,
          },
        },
      ],
      ["503 backend_sealed", { resolve: errorReply(503, "backend_sealed").reply }],
    ] as [string, ServerScript][]) {
      const server = await serve(script);
      const result = await runCli(exportArgs(join(out, "app.env")), { env: envOf(server) });
      expect([65, 69], label).toContain(result.code);
      expect(readdirSync(out), label).toEqual([]);
    }
  });

  it("--token-stdin works for export", async () => {
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const env = envOf(server);
    delete env.SECRETS_MACHINE_TOKEN;
    const target = join(out, "stdin.env");
    const result = await runCli([...exportArgs(target), "--token-stdin"], {
      env,
      stdin: `${token()}\n`,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(digestsOfFile(target)).toEqual(expected);
  });
});
