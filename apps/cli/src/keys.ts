// `secrets keys` (FR-1.47): the live names of the bound environment, one a
// line, in the API's order. Nothing is printed unless the whole answer passed
// the validator; never a value.
import type { ApiClient, Selector } from "./client.ts";

export async function keysCommand(
  client: ApiClient,
  selector: Selector,
  credential: { token: string },
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const body = await client.keys(selector, credential.token);
  credential.token = "";
  if (body.names.length > 0) {
    await new Promise<void>((resolve, reject) => {
      stdout.write(`${body.names.join("\n")}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }
  return 0;
}
