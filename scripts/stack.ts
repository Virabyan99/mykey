// Local development stack control.
// Run: node scripts/stack.ts up | down [--all] | status
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEV_PROJECT,
  TEST_PROJECT_PREFIX,
  listStackProjects,
  stackStatus,
  startStack,
  stopStack,
} from "../tests/harness/stack.ts";

const STACK_ROOT = resolve(import.meta.dirname, "../.stack");

async function up(): Promise<void> {
  const stack = await startStack({ project: DEV_PROJECT, fixedPorts: true });
  console.log(`stack ${stack.project} is up`);
  console.log(`  PostgreSQL  ${stack.pg.host}:${stack.pg.port} (TLS, CA ${stack.pg.caCertPath})`);
  console.log(`  OpenBao     ${stack.bao.url} (TLS, same CA)`);
  console.log(`  credentials .stack/${stack.project}/stack.json (development only, git-ignored)`);
}

async function down(all: boolean): Promise<void> {
  const projects = new Set(all ? await listStackProjects() : [DEV_PROJECT]);
  if (all && existsSync(STACK_ROOT)) {
    // Also sweep state directories whose containers are already gone.
    for (const entry of readdirSync(STACK_ROOT)) {
      if (entry === DEV_PROJECT || entry.startsWith(TEST_PROJECT_PREFIX)) projects.add(entry);
    }
  }
  for (const project of projects) {
    await stopStack(project);
    rmSync(join(STACK_ROOT, project), { recursive: true, force: true });
    console.log(`stack ${project} removed`);
  }
  if (projects.size === 0) console.log("no stack to remove");
}

async function status(): Promise<boolean> {
  const { project, services } = await stackStatus(DEV_PROJECT);
  const running = services.filter((row) => row.service !== "pki-init");
  if (running.length === 0) {
    console.log(`stack ${project} is not running`);
    return false;
  }
  for (const row of running) console.log(`${row.service}: ${row.state} (${row.health})`);
  return running.every((row) => row.state === "running" && row.health === "healthy");
}

const [command, flag] = process.argv.slice(2);
switch (command) {
  case "up":
    await up();
    break;
  case "down":
    await down(flag === "--all");
    break;
  case "status":
    process.exitCode = (await status()) ? 0 : 1;
    break;
  default:
    console.error("usage: node scripts/stack.ts up | down [--all] | status");
    process.exitCode = 2;
}
