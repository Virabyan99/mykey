// The executable's entry, bundled into dist/secrets.mjs by build.ts. The
// standard streams are reached only when used: creating process.stdin (or
// stdout) can put the shared descriptor into non-blocking mode, and `run`
// hands fds 0–2 to its child untouched.
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  execArgv: process.execArgv,
  get stdin() {
    return process.stdin;
  },
  get stdout() {
    return process.stdout;
  },
  get stderr() {
    return process.stderr;
  },
});
