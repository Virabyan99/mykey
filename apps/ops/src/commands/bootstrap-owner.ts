// ops bootstrap-owner --email <address>; the password on stdin (Run 3.2 Task B).
import type { OpsCommand } from "../cli.ts";

export const bootstrapOwnerCommand: OpsCommand = {
  flags: ["email"],
  summary: "create the first owner and its organization; password on stdin",
  run(_flags, io) {
    io.stderr.write("bootstrap-owner: not available in this build\n");
    return Promise.resolve(1);
  },
};
