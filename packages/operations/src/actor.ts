// Who made a change that both a person and an automation credential can make
// (Session 11, P-191). A machine actor's id is the credential's id: an
// operation's principal and an audit row's actor are written from this.
import type { UserId } from "@mykey/contracts";

export type Actor = { kind: "user"; id: UserId } | { kind: "machine"; id: string };
