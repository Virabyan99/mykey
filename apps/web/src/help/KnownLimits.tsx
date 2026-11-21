// What this stage of the service does not do (Run 8.0, FR-1.102), read from
// docs/runbooks/known-limits.md at build time: its "## " sections and "- "
// items, with **bold** and `code` and nothing else interpreted. Since Run 9.0
// it is the help article "What MyKey does not do".
import knownLimits from "../../../../docs/runbooks/known-limits.md";

interface LimitSection {
  heading: string;
  items: string[];
}

/** The sections of known-limits.md and their items. The file's introduction is not shown. */
export function limitSections(text: string): LimitSection[] {
  const sections: LimitSection[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) sections.push({ heading: line.slice(3).trim(), items: [] });
    else if (line.startsWith("- ")) sections.at(-1)?.items.push(line.slice(2).trim());
  }
  return sections;
}

/** One item as text: **bold** as strong, `code` as code; nothing else is interpreted. */
export function Inline(props: { text: string }) {
  const parts = props.text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter((part) => part !== "");
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2).replaceAll("`", "")}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return part;
      })}
    </>
  );
}

export function KnownLimits() {
  return (
    <section aria-labelledby="known-limits">
      <h2 id="known-limits">Known limits</h2>
      {limitSections(knownLimits).map((section) => (
        <section key={section.heading} aria-label={section.heading}>
          <h3>{section.heading}</h3>
          <ul>
            {section.items.map((item) => (
              <li key={item}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
