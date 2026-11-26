// Run 5.6 Task B (FR-1.50, D-43): what `export` does when the file system
// fails or changes under it, with an ExportFs double. A path is POSIX here.
// Since R5-1 (Run 8.6) the content is written to a temporary file beside the
// target (PART), which is the file a failure removes.
import { API_MAJOR, machineResolveBody } from "@mykey/contracts";
import { CliError, exportCommand, type ApiClient, type ExportFs, type StatLike } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const UID = 1000;
const PART = /^\/home\/u\/\.out\.env\.[0-9a-f]{12}\.part$/;
const VALUE = "synthetic-secret-bytes";

function stat(kind: "dir" | "file", over: Partial<StatLike> = {}): StatLike {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    uid: UID,
    mode: kind === "dir" ? 0o40700 : 0o100600,
    dev: 1,
    ino: 42,
    ...over,
  };
}

/** A tiny file system: directories /, /home, /home/u; one file per created path. */
function fakeFs(opts: {
  writeError?: string;
  dirOwner?: number;
  createdMode?: number;
  replaceBeforeCleanup?: boolean;
}): { fs: ExportFs; files: Map<string, StatLike>; unlinked: string[] } {
  const files = new Map<string, StatLike>();
  const unlinked: string[] = [];
  const dirs = new Map<string, StatLike>([
    ["/", stat("dir", { uid: 0, mode: 0o40755 })],
    ["/home", stat("dir", { uid: 0, mode: 0o40755 })],
    ["/home/u", stat("dir", { uid: opts.dirOwner ?? UID })],
  ]);
  const fs: ExportFs = {
    lstat: (path) => dirs.get(path) ?? files.get(path) ?? null,
    open: (path) => {
      files.set(path, stat("file", { mode: opts.createdMode ?? 0o100600 }));
      return 7;
    },
    fstat: () => [...files.values()][0] ?? stat("file"),
    write: (_fd, data, offset) => {
      if (opts.writeError !== undefined) {
        if (opts.replaceBeforeCleanup === true) {
          const created = [...files.keys()].at(-1);
          if (created !== undefined) files.set(created, stat("file", { ino: 99 }));
        }
        throw Object.assign(new Error("write failed"), { code: opts.writeError });
      }
      return data.length - offset;
    },
    fsync: () => undefined,
    close: () => undefined,
    unlink: (path) => {
      unlinked.push(path);
      files.delete(path);
    },
    link: (from, to) => {
      const existing = files.get(from);
      if (existing === undefined) throw Object.assign(new Error("no source"), { code: "ENOENT" });
      if (files.has(to) || dirs.has(to)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      files.set(to, existing);
    },
    syncDirectory: () => undefined,
  };
  return { fs, files, unlinked };
}

const client: ApiClient = {
  version: () => Promise.resolve({ apiMajor: API_MAJOR }),
  exchange: () => Promise.reject(new Error("unused")),
  keys: () => Promise.reject(new Error("unused")),
  resolve: () =>
    Promise.resolve(
      machineResolveBody.parse({
        apiMajor: API_MAJOR,
        environmentId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f",
        generation: "1",
        count: 1,
        entries: [{ name: "A", value: VALUE }],
        complete: true,
      }),
    ),
};

async function exportWith(fs: ExportFs): Promise<{ error: CliError | null; stderr: string }> {
  let stderr = "";
  const sink = {
    write: (text: string, done?: () => void) => {
      stderr += text;
      done?.();
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  try {
    await exportCommand({
      client,
      selector: { project: "p", env: "dev" },
      credential: { token: "s.synthetic" },
      out: "/home/u/out.env",
      stderr: sink,
      uid: UID,
      fs,
    });
    return { error: null, stderr };
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return { error: error as CliError, stderr };
  }
}

describe("export under a failing file system", () => {
  it("a write that fails with ENOSPC after the creation unlinks the file (same device and inode) → 73", async () => {
    const { fs, files, unlinked } = fakeFs({ writeError: "ENOSPC" });
    const { error } = await exportWith(fs);
    expect(error?.category).toBe("export_target");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatch(PART);
    expect(files.size).toBe(0);
  });

  it("another inode at the path at cleanup → no unlink, cleanup required, no content", async () => {
    const { fs, unlinked } = fakeFs({ writeError: "EIO", replaceBeforeCleanup: true });
    const { error, stderr } = await exportWith(fs);
    expect(error?.category).toBe("export_target");
    expect(error?.message).toMatch(/^cleanup required: \/home\/u\/\.out\.env\.[0-9a-f]{12}\.part$/);
    expect(unlinked).toEqual([]);
    expect(stderr.includes(VALUE)).toBe(false);
    expect(error?.message.includes(VALUE)).toBe(false);
  });

  it("a directory owned by another uid → 73, nothing created", async () => {
    const { fs, files } = fakeFs({ dirOwner: UID + 1 });
    expect((await exportWith(fs)).error?.category).toBe("export_target");
    expect(files.size).toBe(0);
  });

  it("a created file that reports a group bit → 73 and unlinked", async () => {
    const { fs, unlinked } = fakeFs({ createdMode: 0o100640 });
    expect((await exportWith(fs)).error?.category).toBe("export_target");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatch(PART);
  });

  it("the happy path writes, warns once on stderr and returns", async () => {
    const { fs, files } = fakeFs({});
    const { error, stderr } = await exportWith(fs);
    expect(error).toBeNull();
    expect(files.has("/home/u/out.env")).toBe(true);
    expect(stderr).toBe(
      "secrets: /home/u/out.env holds plaintext secrets; protect it and delete it when done\n",
    );
  });
});

// R5-1 (Run 8.6, rule 4): a kill or a crash at any moment of the export must
// not leave a partial file at the target. The content is written to a new
// file of its own in the same directory and appears at the target only by a
// link, after it is complete, synced and closed.
describe("export never shows a partial file at the target", () => {
  it("the target appears only by a link of a complete, synced and closed file; the temporary name is gone afterwards", async () => {
    const log: string[] = [];
    const target = "/home/u/out.env";
    const { fs, files } = fakeFs({});
    const traced: ExportFs = {
      ...fs,
      open: (path, flags, mode) => {
        log.push(`open ${path === target ? "target" : "other"}`);
        return fs.open(path, flags, mode);
      },
      write: (fd, data, offset) => {
        log.push(`write ${String(files.has(target))}`);
        return fs.write(fd, data, offset);
      },
      fsync: (fd) => {
        log.push(`fsync ${String(files.has(target))}`);
        fs.fsync(fd);
      },
      close: (fd) => {
        log.push(`close ${String(files.has(target))}`);
        fs.close(fd);
      },
      link: (from, to) => {
        log.push(`link ${to === target ? "target" : "other"}`);
        fs.link(from, to);
      },
      unlink: (path) => {
        log.push(`unlink ${path === target ? "target" : "other"}`);
        fs.unlink(path);
      },
    };
    const { error } = await exportWith(traced);
    expect(error).toBeNull();
    expect(log).toEqual([
      "open other",
      "write false",
      "fsync false",
      "close false",
      "link target",
      "unlink other",
    ]);
    expect([...files.keys()]).toEqual([target]);
  });

  it("a target created by someone else while the export wrote → 73, nothing replaced, the temporary file removed", async () => {
    const { fs, files, unlinked } = fakeFs({});
    const raced: ExportFs = {
      ...fs,
      close: (fd) => {
        files.set("/home/u/out.env", stat("file", { ino: 7 }));
        fs.close(fd);
      },
    };
    const { error } = await exportWith(raced);
    expect(error?.category).toBe("export_target");
    expect(files.get("/home/u/out.env")?.ino).toBe(7);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0] === "/home/u/out.env").toBe(false);
  });

  // Fixes review F-4: a file system without hard links is not "already exists".
  it("a link the file system refuses (EPERM) → 73 naming no existing output, the temporary file removed", async () => {
    const { fs, files, unlinked } = fakeFs({});
    const noLinks: ExportFs = {
      ...fs,
      link: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
    };
    const { error } = await exportWith(noLinks);
    expect(error?.category).toBe("export_target");
    expect(error?.message).not.toMatch(/already exists/);
    expect(error?.message).toMatch(/hard link/);
    expect(unlinked).toHaveLength(1);
    expect([...files.keys()]).toEqual([]);
  });
});
