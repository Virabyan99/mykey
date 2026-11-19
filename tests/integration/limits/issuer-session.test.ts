// Run 6.3 Task B (P-114, D-49): an archive reuses one issuer session for as
// many environments as fit in 45 s (the session lives 60 s). A project of five
// environments, each with a credential, is archived with one AppRole login of
// the issuer, counted in OpenBao's audit device; the runtime authenticates
// inline (D-17) and logs in nowhere, and no provisioner runs meanwhile.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  archive,
  issueAt,
  newEnvironment,
  newProject,
  type Place,
} from "../../harness/lifecycle-fixture.ts";
import { readAuditLog } from "../../harness/stack.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

/** AppRole logins OpenBao audited in the fixture's namespace so far. */
async function logins(): Promise<number> {
  return (await readAuditLog(f.stack)).filter(
    (entry) =>
      entry.type === "request" &&
      entry.namespacePath.startsWith(f.fx.namespace) &&
      entry.path === "auth/approle/login",
  ).length;
}

describe("the issuer session of an archive (P-114)", () => {
  it("a project archive over five environments logs in to the issuer once", async () => {
    const first = await newProject(f);
    const places: Place[] = [first];
    for (let i = 1; i < 5; i += 1) places.push(await newEnvironment(f, first));
    for (const place of places) await issueAt(f, place);
    const before = await logins();
    const answer = await archive(f, first.projectPath);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "archived", environments: 5, credentialsRevoked: 5 },
    });
    expect((await logins()) - before).toBe(1);
  }, 900_000);
});
