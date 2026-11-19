// Run 6.9 Task B (P-128): the plan of a deploy and the runner of its steps.
// The plan refuses a downgrade, an unrelated commit and an image id the
// release does not list; a normal deploy is the eight steps in order; a
// redeploy of the running release has no migrate. A deploy that stops after
// gate_close leaves the gate closed and continues with --resume; a rollback is
// a deploy of the previous release, journey and report included.
import { describe, expect, it } from "vitest";
import {
  DEPLOY_STEPS,
  deployPlan,
  runDeploy,
  type DeployIo,
  type DeployState,
  type DeployStep,
} from "../../../scripts/host-deploy.ts";
import type { Release } from "../../../infra/release/release-schema.ts";

const id = (c: string) => `sha256:${c.repeat(64)}`;
function release(version: string, commit: string, last = "0018_incarnation"): Release {
  return {
    format: "mykey-host-release/1",
    version,
    commit,
    builtAt: "2026-11-18T12:00:00.000Z",
    images: [
      { name: "api", imageId: id("a"), archive: "api.tar", archiveSha256: "1".repeat(64) },
      {
        name: "provisioner",
        imageId: id("b"),
        archive: "provisioner.tar",
        archiveSha256: "2".repeat(64),
      },
      { name: "ops", imageId: id("c"), archive: "ops.tar", archiveSha256: "3".repeat(64) },
    ],
    baseDigests: { node: id("d") },
    migrations: { last },
    scans: { secrets: "pass", dependencies: "pass", images: "pass" },
  };
}
const NEW = "5a404a6" + "0".repeat(33);
const OLD = "45b5c1f3cc3a" + "0".repeat(28);
const current = { build: OLD.slice(0, 12), lastMigration: "0018_incarnation" };

describe("deployPlan (P-128)", () => {
  it("a normal deploy is the eight steps in order", () => {
    expect(deployPlan(current, release("0.6.0", NEW), { related: true })).toEqual({
      steps: [
        "verify_release",
        "load_images",
        "gate_close",
        "migrate",
        "start",
        "journey",
        "report",
        "gate_open",
      ],
    });
    expect(DEPLOY_STEPS).toHaveLength(8);
  });

  it("a redeploy of the running release has no migrate", () => {
    const plan = deployPlan(
      { build: NEW.slice(0, 12), lastMigration: "0018_incarnation" },
      release("0.6.0", NEW),
      { related: true },
    );
    expect("steps" in plan && plan.steps).not.toContain("migrate");
    expect("steps" in plan && plan.steps).toHaveLength(7);
  });

  it("refuses a release whose last migration is older than the host's", () => {
    expect(deployPlan(current, release("0.5.0", NEW, "0014_archive"), { related: true })).toEqual({
      refused: "downgrade: the release ends at 0014_archive, the host is at 0018_incarnation",
    });
  });

  it("refuses a commit that is neither an ancestor nor a descendant of the running build", () => {
    expect(deployPlan(current, release("0.6.0", NEW), { related: false })).toEqual({
      refused: `commit ${NEW.slice(0, 12)} is not related to the running build ${OLD.slice(0, 12)}`,
    });
  });

  it("refuses an image id given on the command line that the release does not list", () => {
    expect(
      deployPlan(current, release("0.6.0", NEW), { related: true, imageIds: [id("e")] }),
    ).toEqual({ refused: `image ${id("e")} is not in release 0.6.0` });
    expect(
      "steps" in deployPlan(current, release("0.6.0", NEW), { related: true, imageIds: [id("a")] }),
    ).toBe(true);
  });

  it("--install-only ends after load_images; --stay-closed ends after start", () => {
    expect(
      deployPlan(current, release("0.6.0", NEW), { related: true }, { installOnly: true }),
    ).toEqual({ steps: ["verify_release", "load_images"] });
    expect(
      deployPlan(current, release("0.6.0", NEW), { related: true }, { stayClosed: true }),
    ).toEqual({ steps: ["verify_release", "load_images", "gate_close", "migrate", "start"] });
  });
});

function fakeIo(failAt: DeployStep | null = null) {
  let state: DeployState | null = null;
  let gate: "open" | "closed" = "open";
  const ran: DeployStep[] = [];
  const io: DeployIo = {
    state: {
      read: () => Promise.resolve(state),
      write: (s) => {
        state = s;
        return Promise.resolve();
      },
    },
    step: (step) => {
      ran.push(step);
      if (step === failAt) return Promise.reject(new Error(`${step} failed`));
      if (step === "gate_close") gate = "closed";
      if (step === "gate_open") gate = "open";
      return Promise.resolve();
    },
  };
  return {
    io,
    ran,
    gate: () => gate,
    state: () => state,
    fail: (at: DeployStep | null) => {
      failAt = at;
    },
  };
}

describe("runDeploy (P-128)", () => {
  const plan = deployPlan(current, release("0.6.0", NEW), { related: true });
  if (!("steps" in plan)) throw new Error("plan refused");

  it("a deploy that stops after gate_close leaves the gate closed; --resume continues from the next step", async () => {
    const fake = fakeIo("migrate");
    await expect(runDeploy(fake.io, release("0.6.0", NEW), plan)).rejects.toThrow("migrate failed");
    expect(fake.gate()).toBe("closed");
    expect(fake.state()).toEqual({ version: "0.6.0", commit: NEW, done: "gate_close" });
    expect(fake.ran).not.toContain("start");

    fake.fail(null);
    fake.ran.length = 0;
    await runDeploy(fake.io, release("0.6.0", NEW), plan, { resume: true });
    expect(fake.ran).toEqual(["migrate", "start", "journey", "report", "gate_open"]);
    expect(fake.gate()).toBe("open");
    expect(fake.state()).toBeNull();
  });

  it("--resume after migrate continues from start though the host now runs the release (its plan has no migrate)", async () => {
    const fake = fakeIo("journey");
    await expect(runDeploy(fake.io, release("0.6.0", NEW), plan)).rejects.toThrow("journey failed");
    expect(fake.state()).toMatchObject({ done: "start" });
    // Replanned on the host as it is now: it runs the release's build already.
    const replanned = deployPlan(
      { build: NEW.slice(0, 12), lastMigration: "0018_incarnation" },
      release("0.6.0", NEW),
      { related: true },
    );
    if (!("steps" in replanned)) throw new Error("plan refused");
    expect(replanned.steps).not.toContain("migrate");
    await fake.io.state.write({ version: "0.6.0", commit: NEW, done: "migrate" });
    fake.fail(null);
    fake.ran.length = 0;
    await runDeploy(fake.io, release("0.6.0", NEW), replanned, { resume: true });
    expect(fake.ran).toEqual(["start", "journey", "report", "gate_open"]);
  });

  it("--resume refuses a state of another release; a new deploy starts from step 1", async () => {
    const fake = fakeIo("start");
    await expect(runDeploy(fake.io, release("0.6.0", NEW), plan)).rejects.toThrow("start failed");
    await expect(runDeploy(fake.io, release("0.5.9", OLD), plan, { resume: true })).rejects.toThrow(
      /release 0.6.0/,
    );
    fake.fail(null);
    fake.ran.length = 0;
    await runDeploy(fake.io, release("0.5.9", OLD), plan);
    expect(fake.ran).toEqual([...DEPLOY_STEPS]);
  });

  it("a rollback is a deploy of the previous release: every step, journey and report included", async () => {
    const fake = fakeIo();
    await runDeploy(fake.io, release("0.6.0", NEW), plan);
    fake.ran.length = 0;
    const back = deployPlan(
      { build: NEW.slice(0, 12), lastMigration: "0018_incarnation" },
      release("0.5.9", OLD),
      { related: true },
    );
    if (!("steps" in back)) throw new Error(back.refused);
    await runDeploy(fake.io, release("0.5.9", OLD), back);
    expect(fake.ran).toEqual([...DEPLOY_STEPS]);
    expect(fake.gate()).toBe("open");
  });
});
