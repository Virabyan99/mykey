// Run 6.9 Task B (P-128, D-57): a deploy promotes a release through the
// closed gate. The plan is pure; the runner walks its steps over a DeployIo
// (host.ts gives one over SSH) and writes a state line after each, so a deploy
// that stops leaves the gate closed and `deploy --resume` continues from the
// next step. A rollback is a deploy of the previous release: the same steps,
// journey and report included.
import type { Release } from "../infra/release/release-schema.ts";

export const DEPLOY_STEPS = [
  "verify_release",
  "load_images",
  "gate_close",
  "migrate",
  "start",
  "journey",
  "report",
  "gate_open",
] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

export interface DeployPlan {
  steps: readonly DeployStep[];
}

/** What the host runs now: its API's build and its last applied migration. */
export interface DeployCurrent {
  build: string;
  lastMigration: string;
}

export function deployPlan(
  current: DeployCurrent,
  release: Release,
  facts: {
    /** The release's commit is an ancestor or a descendant of the running build. */
    related: boolean;
    /** Image ids named on the command line, if any. */
    imageIds?: readonly string[];
  },
  mode: { installOnly?: boolean; stayClosed?: boolean } = {},
): DeployPlan | { refused: string } {
  if (release.migrations.last < current.lastMigration) {
    return {
      refused: `downgrade: the release ends at ${release.migrations.last}, the host is at ${current.lastMigration}`,
    };
  }
  const build = release.commit.slice(0, 12);
  if (!facts.related) {
    return { refused: `commit ${build} is not related to the running build ${current.build}` };
  }
  const listed = new Set(release.images.map((image) => image.imageId));
  for (const imageId of facts.imageIds ?? []) {
    if (!listed.has(imageId))
      return { refused: `image ${imageId} is not in release ${release.version}` };
  }
  if (mode.installOnly === true) return { steps: ["verify_release", "load_images"] };
  const redeploy = current.build === build;
  const steps = DEPLOY_STEPS.filter((step) => !(redeploy && step === "migrate"));
  if (mode.stayClosed === true) return { steps: steps.slice(0, steps.indexOf("start") + 1) };
  return { steps };
}

/** The host's line of what this deploy has done (`/var/lib/mykey/deploy-state.json`). */
export interface DeployState {
  version: string;
  commit: string;
  done: DeployStep;
}

export interface DeployIo {
  state: { read(): Promise<DeployState | null>; write(state: DeployState | null): Promise<void> };
  step(step: DeployStep): Promise<void>;
}

export async function runDeploy(
  io: DeployIo,
  release: Release,
  plan: DeployPlan,
  opts: { resume?: boolean } = {},
): Promise<void> {
  let steps = plan.steps;
  if (opts.resume === true) {
    const state = await io.state.read();
    if (state === null) throw new Error("deploy --resume: no deploy to continue");
    if (state.commit !== release.commit) {
      throw new Error(
        `deploy --resume: the stopped deploy is of release ${state.version}; give that release, or deploy this one without --resume`,
      );
    }
    steps = steps.slice(steps.indexOf(state.done) + 1);
  }
  for (const step of steps) {
    await io.step(step);
    await io.state.write({ version: release.version, commit: release.commit, done: step });
  }
  await io.state.write(null);
}
