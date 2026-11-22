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

  it("known limits (on the Help screen): the archive lock is beyond every host token, not beyond the owner", () => {
    const text = textOf("docs/runbooks/known-limits.md");
    expect(text).not.toContain("even by the owner");
    expect(text).toContain("No token a host or CI holds can delete a segment or change the lock");
  });
});
