// The provisioner's entry point on a host (Run 3.8). Settings from the
// environment, secrets from mounted files; JSON log lines on stdout.
import { configFromEnvironment, MissingSetting } from "./config.ts";
import { startProvisioner } from "./worker.ts";

const log = (entry: object): void => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
};

let config;
try {
  config = configFromEnvironment(process.env);
} catch (error) {
  log({
    event: "startup_refused",
    setting: error instanceof MissingSetting ? error.setting : "unknown",
  });
  process.exit(1);
}
const provisioner = await startProvisioner(config, { log });
const stop = (): void => {
  void provisioner.stop().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
