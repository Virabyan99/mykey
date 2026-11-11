// A TCP relay in front of a TLS server, for client tests that need a
// connection to fail AFTER the handshake (Run 2.4). It never decrypts: it reads
// the TLS record headers of the client's stream. After the client's
// ChangeCipherSpec record comes its Finished record; the record after that is
// the first one carrying the request. From that record on the relay passes
// nothing back to the client, and then either
//   - "drop": closes both connections 300 ms later (the server has the request), or
//   - "hold": keeps both open until close() (a server that never answers).
import net from "node:net";

export type RelayMode = "drop" | "hold";

export interface TlsRelay {
  port: number;
  /** Resolves when a request record has been passed to the server. */
  requestForwarded: Promise<void>;
  close(): Promise<void>;
}

const RECORD_HEADER = 5;
const CHANGE_CIPHER_SPEC = 0x14;

export async function startTlsRelay(
  target: { host: string; port: number },
  mode: RelayMode,
): Promise<TlsRelay> {
  const sockets = new Set<net.Socket>();
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

    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= RECORD_HEADER) {
        const length = pending.readUInt16BE(3);
        if (pending.length < RECORD_HEADER + length) break;
        const record = pending.subarray(0, RECORD_HEADER + length);
        pending = pending.subarray(RECORD_HEADER + length);
        const type = record[0];
        upstream.write(record);
        if (phase === 0 && type === CHANGE_CIPHER_SPEC) phase = 1;
        else if (phase === 1) phase = 2;
        else if (phase === 2 && !requestSeen) {
          requestSeen = true;
          markForwarded();
          if (mode === "drop") {
            setTimeout(() => {
              client.destroy();
              upstream.destroy();
            }, 300);
          }
        }
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!requestSeen) client.write(chunk);
    });
    const end = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", () => {
      sockets.delete(client);
      if (mode === "drop" || !requestSeen) upstream.destroy();
    });
    upstream.on("close", () => sockets.delete(upstream));
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    requestForwarded,
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
