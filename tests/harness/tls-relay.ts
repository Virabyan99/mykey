// A TCP relay in front of a TLS server, for tests that need the network to
// misbehave AFTER the handshake (Run 2.4, ruling R46). It never decrypts: it
// reads the TLS record headers of the client's stream. After the client's
// ChangeCipherSpec record comes its Finished record; every record after that
// carries the request. The handshake itself always passes at once.
//
// Modes:
//   - "pass": the request and the answer pass, each after the delay set with
//     delayRequests / delayResponses (taken when a record or chunk arrives);
//   - "drop": the request passes, nothing comes back, and both connections are
//     closed 300 ms after its first record (the server has the request);
//   - "hold": the first request record passes and nothing ever comes back.
//
// In "pass" mode, swallowRequests(true) (Run 4.5) discards every request record
// after the handshake: the server never sees the request, the client waits for
// its deadline. Such a connection's server side is closed with the client's.
//
// A delayed request whose server connection has closed in the meantime is lost,
// as it would be on a real network once the receiving process is gone.
import net from "node:net";

export type RelayMode = "pass" | "drop" | "hold";

export interface TlsRelay {
  port: number;
  /** Resolves when the first request record has been passed to the server. */
  requestForwarded: Promise<void>;
  /** Wall-clock times at which request records were passed to the server. */
  forwardedAt: number[];
  delayRequests(ms: number): void;
  /** Delays every request record after a connection's first one: the headers arrive, the rest of a large body waits. */
  delayRequestTail(ms: number): void;
  delayResponses(ms: number): void;
  /** Requests never reach the server while on (a change that did not land). */
  swallowRequests(on: boolean): void;
  clear(): void;
  close(): Promise<void>;
}

const RECORD_HEADER = 5;
const CHANGE_CIPHER_SPEC = 0x14;

const later = (ms: number): Promise<void> =>
  new Promise((resolveLater) => setTimeout(resolveLater, Math.max(0, ms)));

export async function startTlsRelay(
  target: { host: string; port: number },
  mode: RelayMode = "pass",
): Promise<TlsRelay> {
  const sockets = new Set<net.Socket>();
  const forwardedAt: number[] = [];
  let requestDelay = 0;
  let tailDelay = 0;
  let responseDelay = 0;
  let swallow = false;
  let markForwarded: () => void = () => undefined;
  const requestForwarded = new Promise<void>((resolveForwarded) => {
    markForwarded = resolveForwarded;
  });

  const server = net.createServer((client) => {
    const upstream = net.connect(target);
    sockets.add(client).add(upstream);
    let pending = Buffer.alloc(0);
    // 0: before the client's ChangeCipherSpec; 1: its Finished is next; 2: request records.
    let phase = 0;
    let requestSeen = false;
    let swallowed = false;
    // Keeps records in order when they are delayed.
    let toServer = Promise.resolve();
    let toClient = Promise.resolve();

    const forward = (record: Buffer, delayMs: number): void => {
      const due = Date.now() + delayMs;
      toServer = toServer.then(async () => {
        await later(due - Date.now());
        if (upstream.destroyed) return;
        upstream.write(record);
        forwardedAt.push(Date.now());
        markForwarded();
      });
    };

    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= RECORD_HEADER) {
        const length = pending.readUInt16BE(3);
        if (pending.length < RECORD_HEADER + length) break;
        const record = pending.subarray(0, RECORD_HEADER + length);
        pending = pending.subarray(RECORD_HEADER + length);
        const type = record[0];
        if (phase < 2) {
          upstream.write(record);
          if (phase === 0 && type === CHANGE_CIPHER_SPEC) phase = 1;
          else if (phase === 1) phase = 2;
          continue;
        }
        if (mode !== "pass") {
          // "drop" passes every request record until the cut, so the server has the
          // whole request even when the client wrote headers and body as separate
          // records (that made the "it was applied" check flaky, Run 2.10); "hold"
          // passes only the first, and the late-write tests rely on that.
          if (requestSeen && mode === "hold") continue;
          const first = !requestSeen;
          requestSeen = true;
          forward(record, 0);
          if (mode === "drop" && first) {
            setTimeout(() => {
              client.destroy();
              upstream.destroy();
            }, 300);
          }
          continue;
        }
        if (swallow) {
          swallowed = true;
          continue;
        }
        // The first request record carries the HTTP headers; a large body follows in more records.
        forward(record, requestSeen ? requestDelay + tailDelay : requestDelay);
        requestSeen = true;
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!requestSeen) {
        client.write(chunk);
        return;
      }
      if (mode !== "pass") return;
      const due = Date.now() + responseDelay;
      toClient = toClient.then(async () => {
        await later(due - Date.now());
        if (!client.destroyed) client.write(chunk);
      });
    });
    const end = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    // A frozen client keeps its socket; a dead one closes it. Either way the
    // request already on its way still goes on, as on a real network.
    client.on("close", () => {
      sockets.delete(client);
      if (swallowed) upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      void toClient.then(() => client.destroy());
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    requestForwarded,
    forwardedAt,
    delayRequests: (ms) => {
      requestDelay = ms;
    },
    delayRequestTail: (ms) => {
      tailDelay = ms;
    },
    delayResponses: (ms) => {
      responseDelay = ms;
    },
    swallowRequests: (on) => {
      swallow = on;
    },
    clear: () => {
      swallow = false;
      requestDelay = 0;
      tailDelay = 0;
      responseDelay = 0;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) =>
        server.close(() => {
          resolveClose();
        }),
      );
    },
  };
}
