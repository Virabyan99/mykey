// Run 5.8 Task A (P-100, FR-1.85): the two consumer fixtures, no product
// involved. Each image builds from a clean context (the fixture directory as
// it is in Git, plus the release files and secrets-launch.sh under
// mykey-release/, as consumer-deploy.md puts them there). Started with three
// synthetic variables given by `docker run -e` (the entrypoint replaced by the
// server command, so no CLI is involved), GET /check answers their names and
// SHA-256 digests; a variable not named in FIXTURE_NAMES is not answered; the
// answer and the container's log hold no value.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURES,
  buildFixtureImage,
  docker,
  removeContainer,
  waitForCheck,
} from "../harness/consumers.ts";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const containers: string[] = [];

beforeAll(async () => {
  for (const fixture of FIXTURES) await buildFixtureImage(fixture);
}, 1_200_000);

afterAll(() => {
  for (const name of containers) removeContainer(name);
});

describe.each(FIXTURES)("the $label fixture", (fixture) => {
  it("answers the names and digests of FIXTURE_NAMES only, and no value anywhere", async () => {
    const values = {
      FX_ONE: `synthetic-${randomUUID()}`,
      FX_TWO: `synthetic-${randomUUID()}`,
      FX_THREE: `synthetic-${randomUUID()}`,
    };
    const hidden = `synthetic-${randomUUID()}`;
    const name = `mykey-fixture-test-${fixture.key}-${randomUUID().slice(0, 8)}`;
    containers.push(name);
    const started = docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1::3000",
        ...Object.keys(values).flatMap((key) => ["-e", key]),
        "-e",
        "FX_HIDDEN",
        "-e",
        "FIXTURE_NAMES=FX_ONE,FX_TWO,FX_THREE,FX_ABSENT",
        "--entrypoint",
        fixture.start[0] ?? "",
        fixture.image,
        ...fixture.start.slice(1),
      ],
      { env: { ...values, FX_HIDDEN: hidden } },
    );
    expect(started.status, started.stderr).toBe(0);
    const answer = await waitForCheck(name);
    expect(answer.names.sort()).toEqual(["FX_ONE", "FX_THREE", "FX_TWO"]);
    expect(answer.digests).toEqual(
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, sha(value)])),
    );
    const raw = JSON.stringify(answer);
    const logs = docker(["logs", name]);
    for (const value of [...Object.values(values), hidden]) {
      expect(raw.includes(value)).toBe(false);
      expect(logs.stdout.includes(value) || logs.stderr.includes(value)).toBe(false);
    }
    expect(raw.includes(sha(hidden))).toBe(false);
  }, 180_000);
});
