// Doc 04 FR-1.34: the canonical export is read back by the pinned Next.js and
// python-dotenv loaders. Whenever a loader returns something other than the
// original value, loaderWarnings() must have named that key for that loader.
// The observed differences are kept, as a generated table, in
// docs/runbooks/dotenv-format-v1.md; this suite fails when that table is stale.
//
// Needs Python 3 on PATH. python-dotenv is installed with --require-hashes into
// .stack/dotenv-loaders-venv (git-ignored). A missing interpreter is a failure,
// not a skip.
import { loaderWarnings, parseDotenv, serializeDotenv } from "@mykey/contracts";
import type { LoaderWarning } from "@mykey/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLock } from "../../../scripts/pins-verify.ts";

type Loader = LoaderWarning["loader"];
type Reason = LoaderWarning["reason"];

interface Case {
  name: string;
  about: string;
  value: string;
}
interface CaseSet {
  name: string;
  description: string;
  cases: Case[];
}
interface Corpus {
  description: string;
  sets: CaseSet[];
}
/** What a loader returned: JSON has no `undefined`, so a missing name is absent. */
type LoadedValues = Record<string, string | null>;
interface SetResult {
  warnings: LoaderWarning[];
  loaded: Record<Loader, LoadedValues>;
}

const LOADERS: readonly Loader[] = ["nextjs", "python-dotenv"];
const LOADER_PACKAGE: Record<Loader, string> = {
  nextjs: "@next/env",
  "python-dotenv": "python-dotenv",
};

const REPOSITORY = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(REPOSITORY, "tests/fixtures/dotenv-loaders");
const NODE_LOADER = join(FIXTURES, "node-loader.ts");
const PYTHON_CHECK = join(FIXTURES, "python/check.py");
const REQUIREMENTS = join(FIXTURES, "python/requirements.txt");
const VENV = join(REPOSITORY, ".stack/dotenv-loaders-venv");
const RUNBOOK = join(REPOSITORY, "docs/runbooks/dotenv-format-v1.md");
const TABLE_START = "<!-- loader-table:start -->";
const TABLE_END = "<!-- loader-table:end -->";
const WRITE_TABLE = process.env.MYKEY_WRITE_LOADER_TABLE === "1";

const lock = loadLock(REPOSITORY);
const corpus = JSON.parse(readFileSync(join(FIXTURES, "corpus.json"), "utf8")) as Corpus;
const mainSet = corpus.sets.find((set) => set.name === "main");

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
    ...(env === undefined ? {} : { env }),
  });
}

/** A child environment with nothing in it a dotenv file could refer to. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const name of ["PATH", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function findPython(): string {
  const candidates =
    process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      if (/^Python 3\.\d+/.test(run(candidate, ["--version"]).trim())) return candidate;
    } catch {
      // Not installed under this name; try the next one.
    }
  }
  throw new Error(
    `Python 3 was not found on PATH (tried ${candidates.join(", ")}). ` +
      "The dotenv loader test needs it and does not skip.",
  );
}

function installedPythonDotenv(python: string): string | null {
  try {
    const script = "import importlib.metadata as m; print(m.version('python-dotenv'))";
    return run(python, ["-I", "-c", script]).trim();
  } catch {
    return null;
  }
}

/** Creates the virtual environment if needed and returns its interpreter. */
function ensureVenv(pinnedVersion: string): string {
  const python = join(VENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) {
    mkdirSync(dirname(VENV), { recursive: true });
    run(findPython(), ["-m", "venv", VENV]);
  }
  if (installedPythonDotenv(python) !== pinnedVersion) {
    const pip = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
    const pinned = ["--no-deps", "--only-binary", ":all:", "--require-hashes", "-r", REQUIREMENTS];
    run(python, [...pip, ...pinned]);
  }
  return python;
}

let workDirectory = "";
let venvPython = "";
const versions: Record<Loader, string> = { nextjs: "", "python-dotenv": "" };
const results = new Map<string, SetResult>();
let processEnvMatchesEverywhere = true;

function loadWithNext(file: Uint8Array): LoadedValues {
  const directory = mkdtempSync(join(workDirectory, "next-"));
  writeFileSync(join(directory, ".env"), file);
  const output = run(
    process.execPath,
    [NODE_LOADER, directory],
    cleanEnv({ NODE_ENV: "production" }),
  );
  const parsed = JSON.parse(output) as {
    version: string;
    values: LoadedValues;
    processEnvMatches: boolean;
  };
  versions.nextjs = parsed.version;
  processEnvMatchesEverywhere &&= parsed.processEnvMatches;
  return parsed.values;
}

function loadWithPython(file: Uint8Array): LoadedValues {
  const directory = mkdtempSync(join(workDirectory, "python-"));
  const path = join(directory, "canonical.env");
  writeFileSync(path, file);
  const output = run(venvPython, ["-I", "-X", "utf8", PYTHON_CHECK, path], cleanEnv({}));
  const parsed = JSON.parse(output) as { version: string; values: LoadedValues };
  versions["python-dotenv"] = parsed.version;
  return parsed.values;
}

function resultOf(set: CaseSet): SetResult {
  const result = results.get(set.name);
  if (result === undefined) throw new Error(`set ${set.name} was not loaded`);
  return result;
}

function isWarned(result: SetResult, name: string, loader: Loader, reason?: Reason): boolean {
  return result.warnings.some(
    (warning) =>
      warning.name === name &&
      warning.loader === loader &&
      (reason === undefined || warning.reason === reason),
  );
}

function isChanged(result: SetResult, loader: Loader, { name, value }: Case): boolean {
  return result.loaded[loader][name] !== value;
}

function extraNames(result: SetResult, loader: Loader, set: CaseSet): string[] {
  const known = new Set(set.cases.map((entry) => entry.name));
  return Object.keys(result.loaded[loader])
    .filter((name) => !known.has(name))
    .sort();
}

// ---- the generated table -------------------------------------------------

/** JSON string literal in printable ASCII only, so the document has no invisible characters. */
function asciiJson(value: string): string {
  return JSON.stringify(value).replace(
    /[^ -~]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function code(text: string): string {
  if (text.includes("|")) throw new Error("a corpus value must not contain a pipe character");
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function loadedCell(result: SetResult, loader: Loader, entry: Case): string {
  const loaded = result.loaded[loader][entry.name];
  if (loaded === undefined) return "**missing**";
  if (loaded === null) return "**no value**";
  return loaded === entry.value ? "same" : code(asciiJson(loaded));
}

function warningCell(result: SetResult, name: string): string {
  const own = result.warnings.filter((warning) => warning.name === name);
  if (own.length === 0) return "none";
  return own.map((warning) => `${warning.loader}: ${warning.reason}`).join("; ");
}

function renderTable(): string {
  const next = `\`@next/env\` ${versions.nextjs}`;
  const python = `\`python-dotenv\` ${versions["python-dotenv"]}`;
  const lines: string[] = [];
  for (const set of corpus.sets) {
    const result = resultOf(set);
    lines.push(`### Set \`${set.name}\` (${set.cases.length} cases)`, "", set.description, "");
    lines.push(`| Case | Exercises | Original value (JSON) | ${next} | ${python} | Warnings |`);
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const entry of set.cases) {
      const cells = [
        code(entry.name),
        entry.about,
        code(asciiJson(entry.value)),
        loadedCell(result, "nextjs", entry),
        loadedCell(result, "python-dotenv", entry),
        warningCell(result, entry.name),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
    for (const loader of LOADERS) {
      const extra = extraNames(result, loader, set);
      const list = extra.length === 0 ? "none" : extra.map(code).join(", ");
      lines.push(
        `Names \`${LOADER_PACKAGE[loader]}\` returned that are not in the file: ${list}.`,
        "",
      );
    }
  }

  lines.push("### Warnings against observed changes", "");
  lines.push(
    "| Loader | Reason | Cases warned | Of those, changed by the loader | Changed without a warning |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  for (const loader of LOADERS) {
    let unwarnedChanges = 0;
    const counts: Record<Reason, { warned: number; changed: number }> = {
      expansion: { warned: 0, changed: 0 },
      escape: { warned: 0, changed: 0 },
    };
    for (const set of corpus.sets) {
      const result = resultOf(set);
      for (const entry of set.cases) {
        const changed = isChanged(result, loader, entry);
        if (changed && !isWarned(result, entry.name, loader)) unwarnedChanges += 1;
        for (const reason of ["expansion", "escape"] as const) {
          if (!isWarned(result, entry.name, loader, reason)) continue;
          counts[reason].warned += 1;
          if (changed) counts[reason].changed += 1;
        }
      }
    }
    for (const reason of ["expansion", "escape"] as const) {
      const { warned, changed } = counts[reason];
      lines.push(
        `| \`${LOADER_PACKAGE[loader]}\` | ${reason} | ${warned} | ${changed} | ${unwarnedChanges} |`,
      );
    }
  }
  return lines.join("\n");
}

function tableBlock(content: string): string {
  return `${TABLE_START}\n<!-- prettier-ignore-start -->\n\n${content}\n\n<!-- prettier-ignore-end -->\n${TABLE_END}`;
}

function currentTableBlock(document: string): string {
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END);
  if (start === -1 || end < start) {
    throw new Error(`${RUNBOOK} has no ${TABLE_START} … ${TABLE_END} block`);
  }
  return document.slice(start, end + TABLE_END.length);
}

// ---- the suite -------------------------------------------------------------

beforeAll(() => {
  const pin = lock.python["python-dotenv"];
  if (pin === undefined) throw new Error("python-dotenv is not in infra/dependencies.lock.json");
  venvPython = ensureVenv(pin.version);
  workDirectory = mkdtempSync(join(tmpdir(), "mykey-dotenv-loaders-"));
  for (const set of corpus.sets) {
    const entries = set.cases.map(({ name, value }) => ({ name, value }));
    const file = serializeDotenv(entries);
    results.set(set.name, {
      warnings: loaderWarnings(entries),
      loaded: { nextjs: loadWithNext(file), "python-dotenv": loadWithPython(file) },
    });
  }
});

afterAll(() => {
  if (workDirectory !== "") rmSync(workDirectory, { recursive: true, force: true });
});

describe("the loaders under test are the pinned ones", () => {
  it("@next/env is the version in the lock", () => {
    expect(versions.nextjs).toBe(lock.npm["@next/env"]?.version);
  });

  it("python-dotenv is the version in the lock, installed by hash", () => {
    const pin = lock.python["python-dotenv"];
    expect(versions["python-dotenv"]).toBe(pin?.version);
    expect(readFileSync(REQUIREMENTS, "utf8")).toBe(
      `python-dotenv==${pin?.version} --hash=sha256:${pin?.sha256}\n`,
    );
  });

  it("what @next/env puts in process.env is what it returned", () => {
    expect(processEnvMatchesEverywhere).toBe(true);
  });
});

describe("the corpus", () => {
  it("has about 40 cases in the main set and unique, sorted names everywhere", () => {
    expect(mainSet?.cases.length).toBeGreaterThanOrEqual(40);
    for (const set of corpus.sets) {
      const names = set.cases.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
      expect([...names].sort()).toEqual(names);
    }
  });

  it("is lossless through this service's own parser", () => {
    for (const set of corpus.sets) {
      const entries = set.cases.map(({ name, value }) => ({ name, value }));
      const parsed = parseDotenv(serializeDotenv(entries));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.entries.map(({ name, value }) => ({ name, value }))).toEqual(entries);
    }
  });
});

describe.each(corpus.sets)("canonical file of set $name", (set) => {
  describe.each(LOADERS)("read by %s", (loader) => {
    it.each(set.cases)("$name: a changed value has a warning", (entry) => {
      const result = resultOf(set);
      const silentChange =
        isChanged(result, loader, entry) && !isWarned(result, entry.name, loader);
      expect(silentChange, `${loader} changed ${entry.name} and no warning names it`).toBe(false);
    });
  });
});

describe("the warning rules against what the loaders did", () => {
  it("both loaders read many cases back exactly, with no warning", () => {
    if (mainSet === undefined) throw new Error("the corpus has no main set");
    const result = resultOf(mainSet);
    for (const loader of LOADERS) {
      const quiet = mainSet.cases.filter((entry) => !isWarned(result, entry.name, loader));
      expect(quiet.length).toBeGreaterThanOrEqual(15);
      expect(quiet.filter((entry) => isChanged(result, loader, entry))).toEqual([]);
    }
  });

  it.each<[Loader, Reason]>([
    ["nextjs", "expansion"],
    ["nextjs", "escape"],
    ["python-dotenv", "expansion"],
  ])("%s %s warnings are backed by a value the loader really changed", (loader, reason) => {
    if (mainSet === undefined) throw new Error("the corpus has no main set");
    const result = resultOf(mainSet);
    const evidence = mainSet.cases.filter(
      (entry) => isWarned(result, entry.name, loader, reason) && isChanged(result, loader, entry),
    );
    expect(evidence.length).toBeGreaterThan(0);
  });

  it("@next/env loses exactly the entries warned only because of the line before them", () => {
    if (mainSet === undefined) throw new Error("the corpus has no main set");
    const result = resultOf(mainSet);
    const warnedForNeighbour = mainSet.cases.filter(
      (entry) => isWarned(result, entry.name, "nextjs") && !/[\\"\t$]/.test(entry.value),
    );
    expect(warnedForNeighbour.length).toBeGreaterThanOrEqual(3);
    expect(warnedForNeighbour.filter((entry) => entry.name in result.loaded.nextjs)).toEqual([]);
    const lost = mainSet.cases.filter((entry) => !(entry.name in result.loaded.nextjs));
    expect(lost).toEqual(warnedForNeighbour);
    // python-dotenv treats a backslash as escaping whatever follows it and loses nothing.
    expect(
      mainSet.cases.filter((entry) => !(entry.name in result.loaded["python-dotenv"])),
    ).toEqual([]);
  });

  it("after such a loss, a line separator lets @next/env overwrite another entry; all are warned", () => {
    const separatorSets = corpus.sets.filter((set) => set.name !== "main");
    expect(separatorSets.length).toBeGreaterThanOrEqual(2);
    for (const set of separatorSets) {
      const result = resultOf(set);
      const target = set.cases[0];
      if (target === undefined) throw new Error(`set ${set.name} is empty`);
      expect(target.value).toBe("original");
      expect(result.loaded.nextjs[target.name]).not.toBe("original");
      expect(result.loaded["python-dotenv"][target.name]).toBe("original");
      for (const entry of set.cases) {
        expect(isWarned(result, entry.name, "nextjs", "escape")).toBe(true);
      }
    }
  });

  it("no loader invents a name in the main set", () => {
    if (mainSet === undefined) throw new Error("the corpus has no main set");
    for (const loader of LOADERS) {
      expect(extraNames(resultOf(mainSet), loader, mainSet)).toEqual([]);
    }
  });
});

describe("docs/runbooks/dotenv-format-v1.md", () => {
  it("holds the difference table these loader runs produce", () => {
    const expected = tableBlock(renderTable());
    const document = readFileSync(RUNBOOK, "utf8").replaceAll("\r\n", "\n");
    if (WRITE_TABLE) {
      writeFileSync(
        RUNBOOK,
        document.replace(currentTableBlock(document), () => expected),
      );
    }
    const actual = currentTableBlock(readFileSync(RUNBOOK, "utf8").replaceAll("\r\n", "\n"));
    expect(
      actual,
      "the table is stale: run the integration tests once with MYKEY_WRITE_LOADER_TABLE=1",
    ).toBe(expected);
  });
});
