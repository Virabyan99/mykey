// Loads <directory>/.env with the pinned @next/env, the way `next start` does,
// and prints what it produced as JSON on stdout.
// Usage: node node-loader.ts <directory>
import nextEnv from "@next/env";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const directory = process.argv[2];
if (directory === undefined) {
  console.error("usage: node node-loader.ts <directory>");
  process.exit(2);
}

let loaderErrors = 0;
const log = {
  info: (): void => undefined,
  error: (): void => {
    loaderErrors += 1;
  },
};

// dev = false and NODE_ENV=production: the files read are .env.production.local,
// .env.local, .env.production and .env. Only .env exists in the directory.
const { parsedEnv, loadedEnvFiles } = nextEnv.loadEnvConfig(directory, false, log, true);
if (loaderErrors > 0 || loadedEnvFiles.length !== 1 || loadedEnvFiles[0]?.path !== ".env") {
  console.error(`@next/env did not load exactly .env (errors: ${loaderErrors})`);
  process.exit(1);
}

const values = parsedEnv ?? {};
// Next.js copies parsedEnv into process.env; say whether the copy is exact here.
const processEnvMatches = Object.entries(values).every(([name, value]) => process.env[name] === value);

const packagePath = createRequire(import.meta.url).resolve("@next/env/package.json");
const version = (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;

process.stdout.write(JSON.stringify({ version, values, processEnvMatches }));
