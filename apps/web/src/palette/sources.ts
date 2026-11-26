// What the command palette can go to (Run 9.0 Task G, P-160): pages,
// projects, environments, help articles and actions. Everything comes from
// the scope the frame already holds (rows the server listed for this caller)
// and from the bundled catalogue. Nothing here asks the server for anything,
// and no secret's name or value is ever a source: the palette goes to the
// secrets list, it does not search it. After sign-out the scope is gone with
// the query cache (forgetData), and so are these entries.
import { webPath } from "@mykey/contracts";
import { ARTICLES } from "../help/articles.ts";

/** The part of the frame's scope (state/scope.tsx) the palette reads: rows the server listed. */
interface Named {
  id: string;
  name: string;
}
export interface PaletteScope {
  organizations: readonly { id: string; role: string }[];
  organization: { id: string; role: string } | null;
  projects: { items: readonly Named[] } | null;
  project: Named | null;
  environments: { items: readonly Named[] } | null;
  environment: Named | null;
}

export type EntryKind = "page" | "project" | "environment" | "help" | "action";

export interface PaletteEntry {
  kind: EntryKind;
  label: string;
  /** Where it goes. An action without an address runs `run`. */
  to?: string;
  run?: "new-project" | "sign-out";
  /** More words it is found by. */
  words: string;
}

const KIND_ORDER: Readonly<Record<EntryKind, number>> = {
  page: 0,
  action: 1,
  project: 2,
  environment: 3,
  help: 4,
};

export function paletteEntries(scope: PaletteScope | null): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const org =
    scope === null
      ? null
      : (scope.organization ?? (scope.organizations.length === 1 ? scope.organizations[0] : null));
  if (org !== null && org !== undefined) {
    const o = { org: org.id };
    entries.push(
      { kind: "page", label: "Home", to: webPath("overview", o), words: "overview projects start" },
      { kind: "page", label: "Activity", to: webPath("activity", o), words: "who did what log" },
      { kind: "page", label: "Audit", to: webPath("audit", o), words: "events log check" },
    );
    if (org.role === "owner" || org.role === "admin") {
      entries.push({
        kind: "page",
        label: "Automation",
        to: webPath("automation", o),
        words: "script provision api tenants",
      });
      entries.push({
        kind: "action",
        label: "New project",
        run: "new-project",
        words: "create add",
      });
    }
    for (const project of scope?.projects?.items ?? []) {
      entries.push({
        kind: "project",
        label: project.name,
        to: webPath("project", { ...o, project: project.id }),
        words: "project",
      });
    }
    const project = scope?.project ?? null;
    if (project !== null) {
      for (const env of scope?.environments?.items ?? []) {
        entries.push({
          kind: "environment",
          label: `${project.name} / ${env.name}`,
          to: webPath("secrets", { ...o, project: project.id, env: env.id }),
          words: "environment",
        });
      }
    }
    const env = scope?.environment ?? null;
    if (project !== null && env !== null) {
      const at = { ...o, project: project.id, env: env.id };
      entries.push(
        { kind: "page", label: "Secrets", to: webPath("secrets", at), words: "values keys" },
        {
          kind: "page",
          label: "Import and export",
          to: webPath("import", at),
          words: "dotenv .env file upload download",
        },
        {
          kind: "page",
          label: "Machine credentials",
          to: webPath("credentials", at),
          words: "tokens issue revoke rotate",
        },
        {
          kind: "page",
          label: "Operations",
          to: webPath("operations", at),
          words: "uncertain state",
        },
        {
          kind: "page",
          label: "Connect an application",
          to: webPath("connect", at),
          words: "cli install run start",
        },
        {
          kind: "action",
          label: "Issue a machine credential",
          to: webPath("credentials", at),
          words: "token new",
        },
        { kind: "action", label: "Add a secret", to: webPath("secrets", at), words: "new create" },
      );
    }
  }
  entries.push(
    { kind: "page", label: "Help centre", to: webPath("help"), words: "questions answers" },
    { kind: "page", label: "Account", to: webPath("account"), words: "password recovery sessions" },
    { kind: "action", label: "Sign out", run: "sign-out", words: "log out leave" },
  );
  for (const article of ARTICLES) {
    entries.push({
      kind: "help",
      label: article.title,
      to: webPath("help-article", { article: article.id }),
      words: article.keywords.join(" "),
    });
  }
  return entries;
}

/** The entries that match what is typed: every word must be in the label or its words. */
export function matchEntries(entries: readonly PaletteEntry[], typed: string): PaletteEntry[] {
  const asked = typed
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const found = entries.filter((entry) => {
    const text = `${entry.label} ${entry.words}`.toLowerCase();
    return asked.every((word) => text.includes(word));
  });
  // The label's own start weighs most; then pages before projects before help.
  return found.sort((a, b) => {
    const first = asked[0] ?? "";
    const starts = (entry: PaletteEntry): number =>
      entry.label.toLowerCase().startsWith(first) ? 0 : 1;
    return starts(a) - starts(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });
}
