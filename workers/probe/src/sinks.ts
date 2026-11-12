// Where alerts go (Run 2.6, D-22). The text names host, condition, kind and
// time only: no address, URL or token of the deployment.
import type { AlertIntent } from "./evaluate.ts";

export type SinkConfig =
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; to: string };

export function formatAlert(alert: AlertIntent): string {
  const time = new Date(alert.sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `MyKey ${alert.host}: ${alert.condition} ${alert.kind} (since ${time} UTC)`;
}

/** True only when the sink answered 2xx. A failure is reported, never thrown. */
export async function deliver(
  sink: SinkConfig,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    let response: Response;
    switch (sink.kind) {
      case "telegram":
        response = await fetcher(`https://api.telegram.org/bot${sink.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: sink.chatId, text }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      case "webhook":
        response = await fetcher(sink.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      case "email":
        // Not configured in Stage 1: the owner chose Telegram (D-22).
        return false;
    }
    return response.ok;
  } catch {
    return false;
  }
}
