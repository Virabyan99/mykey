// A stylesheet is imported for its effect only: esbuild writes it next to the script.
declare module "*.css";

// A Markdown file is bundled as its text (build.ts: the known limits, Run 8.0).
declare module "*.md" {
  const text: string;
  export default text;
}
