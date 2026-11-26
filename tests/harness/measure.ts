// A figure a test measured (Run 11.3). The assertion is what proves; the
// figure is for the decision record that quotes it. With MYKEY_MEASURE_FILE
// set, each call appends one JSON line to that file; without it nothing is
// written. Names and numbers only: never a secret, a token or an address.
import { appendFileSync } from "node:fs";

export function measure(name: string, value: number | string): void {
  const file = process.env.MYKEY_MEASURE_FILE;
  if (file === undefined || file === "") return;
  appendFileSync(file, `${JSON.stringify({ name, value, at: new Date().toISOString() })}\n`);
}
