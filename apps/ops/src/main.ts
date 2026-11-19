// The ops image's entry point (Run 6.2, P-111, D-47): one operator command on
// a host, started by /opt/mykey/hosts/ops-run.sh. The arguments are the
// command and its flags; settings and secret files come from the job. Exit
// codes are runOps's (0 done, 1 failed, 2 refused, 3 needs review, 64 usage);
// a missing setting is 1 and names the setting only.
import { EXIT, runOps } from "./cli.ts";
import { MissingSetting, opsEnvFromEnvironment } from "./host-env.ts";

let env;
try {
  env = opsEnvFromEnvironment(process.env);
} catch (error) {
  const setting = error instanceof MissingSetting ? error.message : "settings unreadable";
  process.stderr.write(`ops: ${setting}\n`);
  process.exit(EXIT.failed);
}
const code = await runOps(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env,
});
process.exit(code);
