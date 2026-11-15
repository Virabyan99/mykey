// The executable's entry, bundled into dist/secrets.mjs by build.ts.
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  execArgv: process.execArgv,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
