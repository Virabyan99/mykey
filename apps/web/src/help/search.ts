// The help centre's search (Run 9.0 Task F): in memory, over the bundled
// articles only; nothing is sent anywhere and nothing is kept. Titles weigh
// most, then keywords, summaries and the text. English plurals are reduced
// to their singular, and the small words of a question are left out.
import { ARTICLES, CLI_EXIT_CODES, type Article, type Block } from "./articles.ts";

const STOP = new Set(
  "a an and are be can do does each for find from how i if in is it its me my of on or the to what when where which who why with you your".split(
    " ",
  ),
);

/** A word as the index keeps it: lower case, no apostrophe, singular. */
export function stem(word: string): string {
  const plain = word.toLowerCase().replaceAll(/['’]/g, "");
  if (plain.length > 4 && plain.endsWith("ies")) return `${plain.slice(0, -3)}y`;
  if (plain.length > 4 && /(?:ss|sh|ch|x)es$/.test(plain)) return plain.slice(0, -2);
  if (plain.length > 3 && plain.endsWith("s") && !plain.endsWith("ss")) return plain.slice(0, -1);
  return plain;
}

export function words(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9'’]+/)
    .filter((word) => word !== "")
    .map(stem)
    .filter((word) => !STOP.has(word));
}

const blockText = (block: Block): string => {
  if (block.kind === "p" || block.kind === "callout" || block.kind === "code") return block.text;
  if (block.kind === "steps" || block.kind === "list") return block.items.join(" ");
  if (block.kind === "screen" || block.kind === "external") return block.text;
  if (block.what === "cli-exit-codes") {
    return CLI_EXIT_CODES.map((row) => `${String(row.code)} ${row.category} ${row.meaning}`).join(
      " ",
    );
  }
  return "";
};

interface Indexed {
  article: Article;
  title: Set<string>;
  titlePhrase: string;
  keywords: Set<string>;
  keywordPhrases: Set<string>;
  summary: Set<string>;
  body: Set<string>;
}

const phrase = (text: string): string => words(text).join(" ");

const INDEX: readonly Indexed[] = ARTICLES.map((article) => ({
  article,
  title: new Set(words(article.title)),
  titlePhrase: phrase(article.title),
  keywords: new Set(article.keywords.flatMap(words)),
  keywordPhrases: new Set(article.keywords.map(phrase)),
  summary: new Set(words(article.summary)),
  body: new Set(article.blocks.flatMap((block) => words(blockText(block)))),
}));

const WEIGHTS = { title: 10, keywords: 8, summary: 3, body: 1 } as const;

const hits = (set: Set<string>, word: string): number => {
  if (set.has(word)) return 1;
  // A word that is the start of an indexed word ("cred" in "credential") counts half.
  if (word.length >= 3) for (const known of set) if (known.startsWith(word)) return 0.5;
  return 0;
};

export interface HelpHit {
  article: Article;
  score: number;
}

/** The articles that answer a query, best first; nothing for an empty query. */
export function searchHelp(query: string): HelpHit[] {
  const asked = words(query);
  if (asked.length === 0) return [];
  const whole = asked.join(" ");
  const found: HelpHit[] = [];
  for (const entry of INDEX) {
    let score = 0;
    let matched = 0;
    for (const word of asked) {
      const best = Math.max(
        hits(entry.title, word) * WEIGHTS.title,
        hits(entry.keywords, word) * WEIGHTS.keywords,
        hits(entry.summary, word) * WEIGHTS.summary,
        hits(entry.body, word) * WEIGHTS.body,
      );
      if (best > 0) matched += 1;
      score += best;
    }
    if (matched === 0) continue;
    // Every word of the question found here weighs more than many words found once.
    if (matched === asked.length) score *= 1.5;
    if (entry.titlePhrase === whole) score += 40;
    else if (entry.titlePhrase.includes(whole)) score += 15;
    if (entry.keywordPhrases.has(whole)) score += 20;
    found.push({ article: entry.article, score });
  }
  return found.sort((a, b) => b.score - a.score);
}
