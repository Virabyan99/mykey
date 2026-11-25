// Run 8.7 Task C (AC-1.60, FR-1.102): the claims walk found fixed texts of the
// page that say more than the product does. Each case names the false wording,
// which must be gone, and the true wording, which must be there.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
// JSX breaks lines anywhere; compare the text with its whitespace collapsed.
const textOf = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

describe("the page claims no more than the product does", () => {
  it("export: the audit row holds the number of names, not the names", () => {
    const text = textOf("apps/web/src/screens/export.tsx");
    expect(text).not.toContain("with the names it holds");
    expect(text).toContain("with the number of names it holds");
  });

  it("secrets: values are read on Reveal, by an export and by an import's preview", () => {
    const text = textOf("apps/web/src/screens/secrets.tsx");
    expect(text).not.toContain("and at no other time");
    expect(text).toMatch(/press Reveal on a secret&apos;s page, when you export/);
    expect(text).toContain("preview an import");
  });

  // Run 9.0: the first-run guide of help.tsx became the help centre's articles (help/articles.ts).
  it("help: the install checks the CLI and its Node runtime, not every file", () => {
    const text = textOf("apps/web/src/help/articles.ts");
    expect(text).not.toContain("checks every file it downloads");
    expect(text).toContain("checks the CLI and the Node runtime it downloads");
  });

  it("errors: a closed service refuses changes; a repeat may meet the same stored refusal", () => {
    const text = textOf("apps/web/src/errors/explain.ts");
    expect(text).not.toContain("Nothing can be read or changed until it is opened");
    expect(text).toContain("Changes are refused until it is opened");
    // The page keeps the key of an open outcome (use-action.ts), so the same
    // refusal can answer again; a new start of the change gets a new key.
    expect(
      text.match(/If the same answer comes back, close the form and start the change again/g),
    ).toHaveLength(2);
  });

  // Session 11 (Run 11.6, D-82): what the page says of the two new credentials.
  it("automation: it reads no value itself, and the page says what a runtime credential it issues can read", () => {
    const text = [
      textOf("apps/web/src/copy/credentials.ts"),
      textOf("apps/web/src/copy/pages.ts"),
      textOf("apps/web/src/copy/actions.ts"),
      textOf("apps/web/src/help/articles.ts"),
    ].join(" ");
    // The false wordings: a holder of the right can reach values in two steps (D-82).
    expect(text).not.toMatch(/automation (credential )?can never reach a value/i);
    expect(text).not.toContain("cannot lead to a value");
    expect(text).toContain("No route lets it read, change or delete a secret");
    expect(text).toContain("A runtime credential it issues reads the values of its environment");
  });

  it("automation: revoking stops the credential and leaves what it made working", () => {
    const text = textOf("apps/web/src/copy/actions.ts");
    expect(text).not.toContain("revokes the runtime credentials it issued");
    expect(text).toContain(
      "The projects its chain manages, their secrets and every runtime credential it issued keep working",
    );
  });

  it("runtime: the secret is kept as a keyed digest, and a revoked credential's last token is refused by MyKey at once", () => {
    const copy = textOf("apps/web/src/copy/credentials.ts");
    expect(copy).not.toContain("MyKey keeps no copy");
    expect(copy).toContain("MyKey keeps a keyed digest of it, never the secret");
    const actions = textOf("apps/web/src/copy/actions.ts");
    expect(actions).not.toContain("is destroyed at once");
    expect(actions).toContain("MyKey refuses it and every short-lived token made from it");
    expect(actions).toContain("the secret store can still accept such a token");
  });

  it("known limits (on the Help screen): the archive lock is beyond every host token, not beyond the owner", () => {
    const text = textOf("docs/runbooks/known-limits.md");
    expect(text).not.toContain("even by the owner");
    expect(text).toContain("No token a host or CI holds can delete a segment or change the lock");
  });
});
