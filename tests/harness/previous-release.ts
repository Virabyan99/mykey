// Run 6.9 (P-131): a checkout of an earlier commit, outside OneDrive, with its
// own dependencies, so a test can start that commit's API on today's database.
// Made once per workstation (git worktree + pnpm install); reused afterwards.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export function previousCheckout(commit: string): string {
  if (!/^[0-9a-f]{12,40}$/.test(commit)) throw new Error("previousCheckout: a commit id");
  const dir = join(homedir(), "mykey-prev", commit.slice(0, 12));
  if (!existsSync(join(dir, "package.json"))) {
    const added = spawnSync("git", ["worktree", "add", "--detach", dir, commit], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (added.status !== 0) throw new Error(`git worktree add ${commit} failed`);
  }
  if (!existsSync(join(dir, "node_modules", ".modules.yaml"))) {
    const installed = spawnSync("pnpm install --frozen-lockfile", {
      cwd: dir,
      stdio: "inherit",
      shell: true,
    });
    if (installed.status !== 0) throw new Error(`pnpm install in ${dir} failed`);
  }
  return dir;
}
