// The test certificates themselves (Run 5.7 Task C): the set the suite uses,
// made by the project's setup with whatever `openssl` the machine has (OpenSSL
// 3 on Linux, LibreSSL as /usr/bin/openssl on macOS; on Windows the host's
// before the copy into the container). Node accepts the good one from the test
// authority and refuses the other two for the reason each is meant to show.
// The matrix run of cli-v0.1.0 failed on both macOS runners because LibreSSL
// signed with SHA-1, doubled the authority's basicConstraints from the system
// config, and refused `-days -1`.
import { readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { certPaths } from "./certs.ts";

const paths = certPaths();

/** One handshake to 127.0.0.1 against `pair`, trusting only the test authority. */
async function handshake(pair: { cert: string; key: string }, servername: string): Promise<string> {
  const server = createServer(
    { cert: readFileSync(pair.cert), key: readFileSync(pair.key) },
    (_req, res) => {
      res.end("ok");
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          servername,
          ca: readFileSync(paths.ca),
          agent: false,
          rejectUnauthorized: true,
        },
        (res) => {
          res.resume();
          resolve(`ok ${String(res.statusCode)}`);
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? error.message);
      });
      req.end();
    });
  } finally {
    server.close();
  }
}

describe("the CLI test certificates", () => {
  it("the good certificate is accepted for localhost and 127.0.0.1", async () => {
    expect(await handshake(paths.good, "localhost")).toBe("ok 200");
  });

  it("the other-host certificate is refused for its name only", async () => {
    expect(await handshake(paths.otherHost, "localhost")).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("the expired certificate is refused for having expired", async () => {
    expect(await handshake(paths.expired, "localhost")).toBe("CERT_HAS_EXPIRED");
  });
});
