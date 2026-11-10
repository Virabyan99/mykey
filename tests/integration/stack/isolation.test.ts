import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baoFetch,
  freshNamespace,
  mountKvV2,
  restartService,
  stackDirectory,
  startStack,
} from "../../harness/stack.ts";

const root = resolve(import.meta.dirname, "../../..");

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

describe("stack isolation", () => {
  it("two stacks run at the same time on different ports", async () => {
    const [first, second] = await Promise.all([startStack(), startStack()]);
    try {
      expect(first.project).not.toBe(second.project);
      expect(first.project).toMatch(/^mykey-t-[0-9a-f]{8}$/);
      expect(first.pg.port).not.toBe(second.pg.port);
      expect(first.bao.url).not.toBe(second.bao.url);
      expect(first.bao.rootToken).not.toBe(second.bao.rootToken);

      for (const stack of [first, second]) {
        const status = await baoFetch(stack, "/v1/sys/seal-status");
        expect(((await status.json()) as { sealed: boolean }).sealed).toBe(false);
      }

      // A namespace created in one stack does not exist in the other.
      const namespace = await freshNamespace(first);
      const other = await baoFetch(second, `/v1/sys/namespaces/${namespace.path}`);
      expect(other.status).toBe(404);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  it("restart keeps data and auto-unseals", async () => {
    const stack = await startStack();
    try {
      const namespace = await freshNamespace(stack);
      await mountKvV2(stack, namespace.path);
      const write = await baoFetch(stack, "/v1/kv/data/KEEP", {
        method: "POST",
        namespace: namespace.path,
        body: { options: { cas: 0 }, data: { value: "synthetic-kept" } },
      });
      expect(write.status).toBe(200);

      await restartService(stack, "openbao");

      const status = await baoFetch(stack, "/v1/sys/seal-status");
      expect(await status.json()).toMatchObject({ initialized: true, sealed: false });
      const read = await baoFetch(stack, "/v1/kv/data/KEEP", { namespace: namespace.path });
      expect(read.status).toBe(200);
      const body = (await read.json()) as { data: { data: { value: string } } };
      expect(body.data.data.value).toBe("synthetic-kept");
    } finally {
      await stack.stop();
    }
  });

  it("stop() leaves no container, volume or .stack directory", async () => {
    const stack = await startStack();
    const directory = stackDirectory(stack.project);
    expect(existsSync(join(directory, "stack.json"))).toBe(true);
    const filter = `label=com.docker.compose.project=${stack.project}`;
    expect(docker(["ps", "-aq", "--filter", filter]).trim()).not.toBe("");

    await stack.stop();

    expect(docker(["ps", "-aq", "--filter", filter]).trim()).toBe("");
    expect(docker(["volume", "ls", "-q", "--filter", filter]).trim()).toBe("");
    expect(docker(["network", "ls", "-q", "--filter", filter]).trim()).toBe("");
    expect(existsSync(directory)).toBe(false);
  });

  it("key owners in the Compose file are the users the pinned images really run as", () => {
    const compose = readFileSync(join(root, "infra/compose/dev.compose.yml"), "utf8");
    const image = (service: string): string => {
      const match = new RegExp(`\\n  ${service}:\\n    image: (\\S+)`).exec(compose);
      expect(match, `${service} image`).not.toBeNull();
      return match![1]!;
    };
    const declared = (name: string): string => {
      const match = new RegExp(`${name}: "(\\d+:\\d+)"`).exec(compose);
      expect(match, name).not.toBeNull();
      return match![1]!;
    };
    const actual = (ref: string, user: string): string =>
      docker([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        ref,
        "-c",
        `echo $(id -u ${user}):$(id -g ${user})`,
      ]).trim();

    expect(declared("POSTGRES_KEY_OWNER")).toBe(actual(image("postgres"), "postgres"));
    expect(declared("OPENBAO_KEY_OWNER")).toBe(actual(image("openbao"), "openbao"));
  });
});
