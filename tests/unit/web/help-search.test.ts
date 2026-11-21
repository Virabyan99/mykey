// Run 9.0 Task F (FR-1.97, the owner's request "find answers"): the help
// centre's search, in memory over the bundled articles only. Titles weigh
// most, then keywords, summaries and text; English plurals are stemmed.
import { EXIT } from "@mykey/cli";
import { ARTICLES, CLI_EXIT_CODES, searchHelp } from "@mykey/web";
import { describe, expect, it } from "vitest";

const firstOf = (query: string): string | undefined => searchHelp(query)[0]?.article.id;

describe("the help search", () => {
  it('"project id" finds the project-id article first', () => {
    expect(firstOf("project id")).toBe("project-id");
  });

  it('"lost phone" finds the authenticator article', () => {
    expect(firstOf("lost phone")).toBe("lost-authenticator");
  });

  it('"77" finds the CLI exit codes', () => {
    expect(firstOf("77")).toBe("cli-exit-codes");
  });

  it('"uncertain" finds the state article', () => {
    expect(firstOf("uncertain")).toBe("uncertain");
  });

  it("every article is found by its own title", () => {
    const missed = ARTICLES.filter((article) => firstOf(article.title) !== article.id).map(
      (article) => `${article.id}: ${firstOf(article.title) ?? "nothing"}`,
    );
    expect(missed).toEqual([]);
  });

  it("plurals and case do not matter, and nothing is found for nothing", () => {
    expect(firstOf("Recovery Codes")).toBe(firstOf("recovery code"));
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
    expect(searchHelp("zzzzqqq")).toEqual([]);
  });

  it("the exit codes the help names are the CLI's own", () => {
    const named = Object.fromEntries(
      CLI_EXIT_CODES.filter((row) => row.code !== 0).map((row) => [row.category, row.code]),
    );
    expect(named).toEqual(EXIT);
  });
});
