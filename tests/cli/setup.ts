// Global setup of project `cli` (P-97). The CLI refuses native Windows on
// purpose, so its process tests need POSIX: on Windows they run through
// `pnpm run test:cli` in a Linux container. Here: the certificates of the test
// server, and the bundle unless MYKEY_CLI_BIN names the binary to test.
import { spawnSync } from "node:child_process";
import { makeCertificates } from "./certs.ts";

export default function setup(): void {
  if (process.platform === "win32") {
    throw new Error(
      "project cli needs POSIX: run `pnpm run test:cli` (it runs this project in a Linux container)",
    );
  }
  makeCertificates();
  const bin = process.env.MYKEY_CLI_BIN;
  if (bin === undefined || bin === "") {
    const built = spawnSync(process.execPath, ["apps/cli/build.ts"], { encoding: "utf8" });
    if (built.status !== 0)
      throw new Error(`the CLI bundle did not build: ${built.stderr.slice(-400)}`);
  }
}
