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

// The same commands work with OpenSSL 3 and with LibreSSL (/usr/bin/openssl on
// macOS), which differ in three ways that broke the macOS runners: LibreSSL's
// `x509 -req` signs with SHA-1 unless told otherwise (so every signing names
// -sha256), its system config adds a v3_ca section that doubles the
// authority's basicConstraints (so every command reads only CONFIG, below),
// and it refuses `-days -1` (so the expired certificate is signed with
// `openssl ca` and explicit dates).
const CONFIG = [
  "[ req ]",
  "distinguished_name = dn",
  "[ dn ]",
  "[ ca ]",
  "default_ca = test_ca",
  "[ test_ca ]",
  "database = index.txt",
  "new_certs_dir = issued",
  "serial = ca-serial",
  "default_md = sha256",
  "policy = any_name",
  "unique_subject = no",
  "[ any_name ]",
  "commonName = supplied",
  "",
].join("\n");

/** YYMMDDHHMMSSZ (UTCTime), as `openssl ca -startdate/-enddate` take it. */
function utcTime(at: Date): string {
  return `${at.toISOString().slice(2, 19).replace(/[-T:]/g, "")}Z`;
}

function openssl(args: string[], cwd: string): void {
  const result = spawnSync("openssl", args, {
    cwd,
    encoding: "utf8",
    // Git Bash would rewrite "/CN=…" into a Windows path.
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
      OPENSSL_CONF: join(cwd, "openssl.cnf"),
    },
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
  mkdirSync(join(dir, "issued"), { recursive: true });
  writeFileSync(join(dir, "openssl.cnf"), CONFIG);
  writeFileSync(join(dir, "index.txt"), "");
  writeFileSync(join(dir, "ca-serial"), "1000\n");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  const config = ["-config", "openssl.cnf"];
  openssl(
    [
      "req",
      ...config,
      "-x509",
      "-sha256",
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
  const leaf = (name: string, names: string, expired = false): void => {
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
      [
        "req",
        ...config,
        "-sha256",
        ...ec,
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=${name}`,
      ],
      dir,
    );
    const signed = expired
      ? [
          "ca",
          ...config,
          "-batch",
          "-notext",
          "-md",
          "sha256",
          "-cert",
          "ca.pem",
          "-keyfile",
          "ca.key",
          // Valid from three days before it was made until one day before.
          "-startdate",
          utcTime(new Date(Date.now() - 3 * DAY_MS)),
          "-enddate",
          utcTime(new Date(Date.now() - DAY_MS)),
          "-extfile",
          `${name}.ext`,
          "-in",
          `${name}.csr`,
          "-out",
          `${name}.pem`,
        ]
      : [
          "x509",
          "-req",
          "-sha256",
          "-in",
          `${name}.csr`,
          "-CA",
          "ca.pem",
          "-CAkey",
          "ca.key",
          "-CAcreateserial",
          "-days",
          "7",
          "-extfile",
          `${name}.ext`,
          "-out",
          `${name}.pem`,
        ];
    openssl(signed, dir);
  };
  leaf("good", "DNS:localhost,IP:127.0.0.1");
  leaf("other-host", "DNS:other-host.invalid");
  leaf("expired", "DNS:localhost,IP:127.0.0.1", true);
  writeFileSync(marker, new Date().toISOString());
  return certPaths(dir);
}
