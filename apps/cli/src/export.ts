// `secrets export --output <new-file>` (FR-1.50, D-43). In order: resolve and
// validate the complete set → the dotenv text built in memory by the codec →
// check the target → create it exclusively, without following a link, mode
// 0600 → check what was created → write all of it → fsync → close → fsync the
// directory → one line on stderr that the file holds plaintext secrets. Any
// failure after the creation removes the file only when the path still names
// the file this invocation created; otherwise it says "cleanup required" and
// deletes nothing. No chmod, ever.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
// POSIX paths: the CLI runs on Linux and macOS only (the guard refuses Windows).
import { posix } from "node:path";
import { serializeDotenv } from "@mykey/contracts";
import type { ApiClient, Selector } from "./client.ts";
import { CliError } from "./errors.ts";

export interface StatLike {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
}

export interface ExportFs {
  /** null when nothing is at the path. */
  lstat(path: string): StatLike | null;
  open(path: string, flags: number, mode: number): number;
  fstat(fd: number): StatLike;
  /** Bytes written. */
  write(fd: number, data: Uint8Array, offset: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  unlink(path: string): void;
  syncDirectory(path: string): void;
}

export const nodeFs: ExportFs = {
  lstat: (path) => lstatSync(path, { throwIfNoEntry: false }) ?? null,
  open: (path, flags, mode) => openSync(path, flags, mode),
  fstat: (fd) => fstatSync(fd),
  write: (fd, data, offset) => writeSync(fd, data, offset, data.length - offset),
  fsync: (fd) => {
    fsyncSync(fd);
  },
  close: (fd) => {
    closeSync(fd);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
  syncDirectory: (path) => {
    const fd = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

const target = (text: string): CliError => new CliError("export_target", text);

/** The directory and the name of a new file, or export_target. */
export function checkTarget(
  out: string,
  uid: number,
  fs: ExportFs,
): { directory: string; name: string } {
  const absolute = posix.resolve(out);
  const name = posix.basename(absolute);
  const directory = posix.dirname(absolute);
  if (name === "" || name === "." || name === ".." || out.endsWith("/")) {
    throw target("the output must name a file");
  }
  // Every component from the root: present, a directory, never a link.
  const root = "/";
  const parts = directory.split("/").filter((part) => part !== "");
  let current = root;
  for (const part of ["", ...parts]) {
    current = part === "" ? current : current === root ? `${root}${part}` : `${current}/${part}`;
    const stat = fs.lstat(current);
    if (stat === null) throw target("the output's directory does not exist");
    if (stat.isSymbolicLink())
      throw target("the output's directory is reached through a symbolic link");
    if (!stat.isDirectory())
      throw target("a component of the output's directory is not a directory");
  }
  const own = fs.lstat(directory);
  if (own === null) throw target("the output's directory does not exist");
  if (own.uid !== uid) throw target("the output's directory belongs to another user");
  if ((own.mode & 0o022) !== 0)
    throw target("the output's directory is writable by group or others");
  if (fs.lstat(absolute) !== null)
    throw target("the output already exists; export only creates a new file");
  return { directory, name: absolute };
}

export async function exportCommand(p: {
  client: ApiClient;
  selector: Selector;
  credential: { token: string };
  out: string;
  stderr: NodeJS.WritableStream;
  uid: number;
  fs?: ExportFs;
}): Promise<number> {
  const fs = p.fs ?? nodeFs;
  const body = await p.client.resolve(p.selector, p.credential.token);
  p.credential.token = "";
  let bytes: Uint8Array;
  try {
    bytes = serializeDotenv(body.entries);
  } catch {
    throw new CliError("malformed", "the answer holds an entry a dotenv file cannot carry");
  }
  const { directory, name: path } = checkTarget(p.out, p.uid, fs);

  let fd: number;
  try {
    fd = fs.open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw target("the output could not be created as a new file");
  }
  let identity: { dev: number; ino: number } | null = null;
  let open = true;
  try {
    const stat = fs.fstat(fd);
    identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isFile() || stat.uid !== p.uid || (stat.mode & 0o077) !== 0) {
      throw target("the created file is not a private regular file of this user");
    }
    let offset = 0;
    while (offset < bytes.length) offset += fs.write(fd, bytes, offset);
    fs.fsync(fd);
    open = false;
    fs.close(fd);
    fs.syncDirectory(directory);
  } catch (error) {
    if (open) {
      try {
        fs.close(fd);
      } catch {
        // Closing is best effort here: the export has failed either way.
      }
    }
    let now: StatLike | null;
    try {
      now = fs.lstat(path);
    } catch {
      now = null;
    }
    if (identity !== null && now !== null && now.dev === identity.dev && now.ino === identity.ino) {
      try {
        fs.unlink(path);
      } catch {
        throw target(`cleanup required: ${path}`);
      }
    } else if (now !== null) {
      throw target(`cleanup required: ${path}`);
    }
    if (error instanceof CliError && error.category === "export_target") throw error;
    throw target("the output could not be written completely");
  }
  await new Promise<void>((resolveWrite) => {
    p.stderr.write(
      `secrets: ${path} holds plaintext secrets; protect it and delete it when done\n`,
      () => {
        resolveWrite();
      },
    );
  });
  return 0;
}
