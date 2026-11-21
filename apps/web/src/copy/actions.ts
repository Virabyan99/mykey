// What a destructive, export or token action will do, said before it is done
// (P-159, FR-1.96, FR-1.75). Every confirmation of a screen takes its text
// from here, and copy.test.ts checks that each entry is used.
import { LIMITS } from "@mykey/contracts";

const VERSIONS = LIMITS.secret.versionsKept;

export const ACTIONS = {
  deleteSecret: (version: number): string =>
    `Version ${String(version)} stops being readable, by people and by machines. No older version takes its place: the name then has no value. It can be undeleted while it is among the last ${String(VERSIONS)} versions.`,
  undeleteSecret: (version: number): string =>
    `Version ${String(version)} becomes the current value again, readable as before. No new version is made.`,
  restoreVersion: (source: number, current: number): string =>
    `The value of version ${String(source)} is written as a new version on top of version ${String(current)}. Nothing is removed: version ${String(current)} and the versions before it stay in the history.`,
  archive: {
    environment:
      "Archiving revokes every active machine credential of this environment at once: its consumers can no longer read. An issuance that is not finished is withdrawn. The secrets and their history are kept and can still be read here. Nothing is deleted.",
    project:
      "Archiving revokes every active machine credential of every environment of this project at once: their consumers can no longer read. An issuance that is not finished is withdrawn. The secrets and their history are kept and can still be read here. Nothing is deleted.",
  },
  reactivate: {
    environment:
      "Reactivating opens this environment for writes and for new machine credentials again. Its revoked credentials stay revoked: each consumer needs a new one.",
    project:
      "Reactivating opens this project again, with the environments that were archived with it; an environment that was archived on its own stays archived. Their revoked credentials stay revoked: each consumer needs a new one.",
  },
  revoke: [
    "The token of this credential is refused from the moment the server answers. A consumer that still uses it can no longer read its secrets.",
    "A revocation cannot be undone. To give the consumer access again, issue a new credential.",
  ],
  export: [
    "Every live value of this environment is written into one file.",
    "The file is outside MyKey from the moment it is saved: MyKey cannot protect it, cannot see who reads it and cannot take it back.",
  ],
  issue:
    "The token is shown once, right after it is issued: copy it then. MyKey keeps no copy, and the token cannot be shown again or renewed.",
  newRecoveryCodes: "Every recovery code you have now stops working, used or not.",
  endEverySession:
    "Every session of this account ends, this one included. You sign in again afterwards.",
} as const;

export type ActionId = keyof typeof ACTIONS;
