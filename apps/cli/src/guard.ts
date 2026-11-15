// Refused before anything else (P-96, FR-1.79, FR-1.51): runtime settings
// that switch off certificate verification, route traffic through a proxy or
// load code into the CLI, and every platform outside the four targets. These
// checks cannot make a launcher that is already hostile safe (D-43); they stop
// the settings a user or a script might leave on by mistake.
import { CliError } from "./errors.ts";
import { SUPPORTED_TARGETS } from "./identity.ts";

const CODE_FLAGS = [
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
  "--inspect",
  "--insecure-http-parser",
];

export function refuseUnsafeRuntime(p: {
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  platform: string;
  arch: string;
  glibc: string | undefined;
}): void {
  const refuse = (text: string): never => {
    throw new CliError("unsupported", text);
  };
  if (p.platform === "win32") refuse("native Windows is not supported; use Linux or macOS");
  if (!(SUPPORTED_TARGETS as readonly string[]).includes(`${p.platform}-${p.arch}`)) {
    refuse("this platform is not one of linux-x64, linux-arm64, darwin-x64, darwin-arm64");
  }
  if (p.platform === "linux" && (p.glibc === undefined || p.glibc === "")) {
    refuse("this Linux has no glibc; only glibc systems are supported");
  }
  const tls = p.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (tls !== undefined && tls !== "1") refuse("NODE_TLS_REJECT_UNAUTHORIZED must not be set");
  if (p.env.NODE_OPTIONS !== undefined) refuse("NODE_OPTIONS must not be set");
  if (p.env.NODE_USE_ENV_PROXY !== undefined) refuse("NODE_USE_ENV_PROXY must not be set");
  for (const arg of p.execArgv) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (CODE_FLAGS.some((bad) => flag === bad || (bad === "--inspect" && flag.startsWith(bad)))) {
      refuse("Node was started with a flag that loads code or opens a debugger");
    }
  }
}
