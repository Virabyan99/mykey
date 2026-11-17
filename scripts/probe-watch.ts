// Who watches the Worker (Run 6.4 Task D, P-117, D-50). Run by
// .github/workflows/probe-watch.yml every 15 minutes, on the pinned Node with
// no install step (Node's built-ins only): it reads the probe's state route
// and sends one Telegram message when the last evaluation is older than 10
// minutes or the route does not answer. Silent and green otherwise. The text
// names no token; the three values come from repository secrets.
//
//   PROBE_READ_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (environment)
//   node scripts/probe-watch.ts

const PROBE = "https://mykey-probe.nomikey.com";
/** The host whose state the watcher reads; the Worker evaluates every host in one run. */
const HOST = "staging";
/** Ten minutes: ten missed evaluations of a Worker that runs every minute. */
export const STALE_MS = 10 * 60_000;

export interface Verdict {
  alert: boolean;
  text: string;
}

/** `state` is what the route answered, or null when it did not answer. */
export function watchVerdict(state: { evaluatedAt: number | null } | null, nowMs: number): Verdict {
  if (state === null)
    return { alert: true, text: "MyKey probe: state route did not answer (watcher)" };
  if (state.evaluatedAt === null)
    return { alert: true, text: "MyKey probe: never evaluated (watcher)" };
  const age = nowMs - state.evaluatedAt;
  if (age <= STALE_MS) return { alert: false, text: "" };
  return {
    alert: true,
    text: `MyKey probe: not evaluated for ${String(Math.floor(age / 60_000))} min (watcher)`,
  };
}

/** The message as sent: the verdict's text, with any secret value removed (it holds none). */
export function watchText(
  verdict: Verdict,
  secrets: { readToken: string; botToken: string; chatId: string },
): string {
  let text = verdict.text;
  for (const value of [secrets.readToken, secrets.botToken]) {
    if (value.length >= 8) text = text.replaceAll(value, "[redacted]");
  }
  return text;
}

async function readState(token: string): Promise<{ evaluatedAt: number | null } | null> {
  try {
    const response = await fetch(`${PROBE}/v1/state/${HOST}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { evaluatedAt?: unknown };
    return { evaluatedAt: typeof body.evaluatedAt === "number" ? body.evaluatedAt : null };
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const readToken = process.env.PROBE_READ_TOKEN ?? "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  if (readToken === "" || botToken === "" || chatId === "") {
    process.stderr.write(
      "probe-watch: PROBE_READ_TOKEN, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required\n",
    );
    return 2;
  }
  const verdict = watchVerdict(await readState(readToken), Date.now());
  if (!verdict.alert) {
    process.stdout.write("probe-watch: the probe evaluated within 10 minutes\n");
    return 0;
  }
  const text = watchText(verdict, { readToken, botToken, chatId });
  const sent = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(20_000),
  }).then(
    (response) => response.ok,
    () => false,
  );
  process.stdout.write(`probe-watch: ${text} — message ${sent ? "sent" : "NOT sent"}\n`);
  // A red run is a second signal (GitHub mails the repository's owner).
  return 1;
}

if (import.meta.main) process.exitCode = await main();
