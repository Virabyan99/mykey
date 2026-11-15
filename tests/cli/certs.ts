// Certificates for the CLI's test server (P-97), made with `openssl` at run
// time into tests/cli/.certs (git-ignored): one authority, and three server
// certificates it signed: a good one for localhost and 127.0.0.1, one for
// another host name only, and one that has expired. Made once; `force` makes
// them again (scripts/test-cli.ts does, before it copies the tree into the
// Linux container, whose image has no openssl).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), ".certs");

export interface CertPaths {
  ca: string;
  good: { cert: string; key: string };
  otherHost: { cert: string; key: string };
  expired: { cert: string; key: string };
}

export function certPaths(dir: string = CERT_DIR): CertPaths {
  const pair = (name: string) => ({
    cert: join(dir, `${name}.pem`),
    key: join(dir, `${name}.key`),
  });
  return {
    ca: join(dir, "ca.pem"),
    good: pair("good"),
    otherHost: pair("other-host"),
    expired: pair("expired"),
  };
}

function openssl(args: string[], cwd: string): void {
  const result = spawnSync("openssl", args, {
    cwd,
    encoding: "utf8",
    // Git Bash would rewrite "/CN=…" into a Windows path.
    env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
  });
  if (result.status !== 0) {
    throw new Error(
      `openssl ${args[0] ?? ""} failed: ${(result.stderr || String(result.error)).slice(-400)}`,
    );
  }
}

const DONE = "made";
const DAY_MS = 86_400_000;

/** Makes the certificates unless a set younger than a day exists. */
export function makeCertificates(opts: { force?: boolean; dir?: string } = {}): CertPaths {
  const dir = opts.dir ?? CERT_DIR;
  const marker = join(dir, DONE);
  if (opts.force !== true && existsSync(marker) && Date.now() - statSync(marker).mtimeMs < DAY_MS) {
    return certPaths(dir);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(
    [
      "req",
      "-x509",
      ...ec,
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "30",
      "-subj",
      "/CN=MyKey CLI test authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    dir,
  );
  const leaf = (name: string, names: string, days: string): void => {
    writeFileSync(
      join(dir, `${name}.ext`),
      [
        `subjectAltName=${names}`,
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    openssl(
      ["req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`],
      dir,
    );
    openssl(
      [
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-days",
        days,
        "-extfile",
        `${name}.ext`,
        "-out",
        `${name}.pem`,
      ],
      dir,
    );
  };
  leaf("good", "DNS:localhost,IP:127.0.0.1", "7");
  leaf("other-host", "DNS:other-host.invalid", "7");
  // Valid until a day before it was made.
  leaf("expired", "DNS:localhost,IP:127.0.0.1", "-1");
  writeFileSync(marker, new Date().toISOString());
  return certPaths(dir);
}
