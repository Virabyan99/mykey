// The classification of an import file's entries (Run 4.7, P-76; Doc 06 §8
// "Import"). Pure. A name that fails the name rule, or whose value fails the
// value rule, is `invalid` and comes back without its name (it is typed text
// and may be anything). The second and later entry of one name is
// `duplicate`. No index row → `create`. A row deleted or in review, or the key
// an occupied slot names → `conflict`. A live row → `unchanged` when the caller
// could compare the values and they are equal, else `update` with the row's
// version and tag as the entry's precondition.
import { checkSecretName, checkSecretValue } from "@mykey/contracts";
import type { IndexRow } from "@mykey/db";

export type Classification =
  "create" | "update" | "unchanged" | "invalid" | "duplicate" | "conflict";

export interface Classified {
  /** From 1, in file order. */
  ordinal: number;
  line: number;
  /** Null for an invalid entry. */
  name: string | null;
  classification: Classification;
  expectedVersion: number | null;
  expectedStateTag: string | null;
}

export function classifyEntries(
  entries: readonly { name: string; value: string; line: number }[],
  index: ReadonlyMap<string, IndexRow>,
  /** Null: the caller may not read values; every live name is `update`. */
  sameValue: ((name: string, value: string) => boolean) | null,
  /** The key an occupied effect slot names, if any. */
  slotName: string | null = null,
): Classified[] {
  const seen = new Set<string>();
  return entries.map((entry, position) => {
    const base = { ordinal: position + 1, line: entry.line };
    const none = { expectedVersion: null, expectedStateTag: null };
    if (!checkSecretName(entry.name).ok || !checkSecretValue(entry.value).ok) {
      return { ...base, name: null, classification: "invalid", ...none };
    }
    const name = entry.name;
    if (seen.has(name)) return { ...base, name, classification: "duplicate", ...none };
    seen.add(name);
    const row = index.get(name);
    if (row === undefined) return { ...base, name, classification: "create", ...none };
    if (row.state !== "live" || name === slotName) {
      return { ...base, name, classification: "conflict", ...none };
    }
    const precondition = { expectedVersion: row.currentVersion, expectedStateTag: row.stateTag };
    const classification: Classification =
      sameValue?.(name, entry.value) === true ? "unchanged" : "update";
    return { ...base, name, classification, ...precondition };
  });
}
