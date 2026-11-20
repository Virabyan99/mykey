// Import (FR-1.31 to FR-1.36, P-138). The file's bytes are held by this
// screen's own memory, in a ref: never in the query cache, never in React
// state, never in the address. They are sent twice, for the preview and for
// the apply, and dropped when the server has answered the apply and whenever
// the screen goes. The preview is the server's classification and holds no
// value. A result is shown entry by entry: an import is never called done
// when one entry was not written. An import the server stopped before the
// end waits for the same file, which the owner chooses again.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LIMITS,
  type ImportPreviewBody,
  type OperationResponse,
  type OperationsListBody,
} from "@mykey/contracts";
import { useRef, useState, type RefObject } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { useScope } from "../state/scope.tsx";
import { useSessionControl } from "../state/session.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { AreaField, Field } from "../ui/Field.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { Time } from "../ui/Time.tsx";
import { ExportPanel } from "./export.tsx";
import type { At } from "./secret-value.tsx";

type Bytes = Uint8Array<ArrayBuffer>;
type Waiting = OperationsListBody["operations"][number];

const MAX_BYTES = LIMITS.body.dotenvMaxBytes;
const sizeProblem = (size: number): string =>
  `A file may be at most ${MAX_BYTES.toLocaleString("en-US")} bytes (1 MiB). This one has ${size.toLocaleString("en-US")}. Nothing was sent.`;

/** A file input and a paste area. What they hold is read once and then removed from them. */
interface Source {
  file: RefObject<HTMLInputElement | null>;
  paste: RefObject<HTMLTextAreaElement | null>;
  take: () => Promise<{ bytes: Bytes } | { problem: string }>;
}

function useSource(): Source {
  const file = useRef<HTMLInputElement>(null);
  const paste = useRef<HTMLTextAreaElement>(null);
  const take: Source["take"] = async () => {
    const chosen = file.current?.files?.[0];
    const pasted = paste.current?.value ?? "";
    let bytes: Bytes;
    if (chosen !== undefined) {
      if (chosen.size > MAX_BYTES) return { problem: sizeProblem(chosen.size) };
      bytes = new Uint8Array(await chosen.arrayBuffer());
    } else if (pasted !== "") {
      bytes = new Uint8Array(new TextEncoder().encode(pasted));
      if (bytes.length > MAX_BYTES) return { problem: sizeProblem(bytes.length) };
    } else {
      return { problem: "Choose a file or paste its text." };
    }
    if (file.current !== null) file.current.value = "";
    if (paste.current !== null) paste.current.value = "";
    return { bytes };
  };
  return { file, paste, take };
}

function SourceFields(props: { source: Source; problem: string | null }) {
  return (
    <>
      <Field
        label="Dotenv file"
        type="file"
        accept=".env,.txt,text/plain"
        inputRef={props.source.file}
        error={props.problem}
        hint={`One NAME=value per line, at most ${MAX_BYTES.toLocaleString("en-US")} bytes and ${LIMITS.body.dotenvMaxEntries.toLocaleString("en-US")} entries (runbook dotenv-format-v1.md).`}
      />
      <AreaField label="Or paste the text of the file" areaRef={props.source.paste} rows={5} />
    </>
  );
}

const CLASS: Readonly<Record<string, string>> = {
  create: "new",
  update: "changed",
  unchanged: "unchanged",
  invalid: "invalid",
  duplicate: "duplicate",
  conflict: "conflict",
};

/** "8 new, 2 changed, 1 unchanged": the server's counts, the ones that are not zero. */
function countsText(counts: ImportPreviewBody["counts"]): string {
  const order = ["create", "update", "unchanged", "conflict", "invalid", "duplicate"] as const;
  const parts = order
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${String(counts[kind])} ${CLASS[kind] ?? kind}`);
  return parts.length === 0 ? "No entry" : parts.join(", ");
}

function Preview(props: { preview: ImportPreviewBody }) {
  const { preview } = props;
  return (
    <>
      <h3>Preview</h3>
      {preview.entries.length === 0 ? null : <p>{countsText(preview.counts)}</p>}
      {preview.issues.length === 0 ? null : (
        <ul aria-label="Problems in the file">
          {preview.issues.map((issue) => (
            <li key={`${String(issue.line)} ${issue.rule}`}>
              {issue.line === 0 ? "The file" : `Line ${String(issue.line)}`}: the dotenv format
              refuses it, rule <code>{issue.rule}</code>.
            </li>
          ))}
        </ul>
      )}
      {preview.entries.length === 0 ? null : (
        <div className="scroll">
          <table aria-label="Preview of the import">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Name</th>
                <th scope="col">What the import would do</th>
              </tr>
            </thead>
            <tbody>
              {preview.entries.map((entry) => (
                <tr key={entry.ordinal}>
                  <td>{entry.line}</td>
                  <th scope="row">
                    {entry.name ?? <span className="muted">not a valid name</span>}
                  </th>
                  <td>{CLASS[entry.classification] ?? entry.classification}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.warnings.length === 0 ? null : (
        <ul aria-label="Warnings">
          {preview.warnings.map((warning) => (
            <li key={`${warning.name} ${warning.loader} ${warning.kind}`}>
              <code>{warning.name}</code>: the loader {warning.loader} would read this value
              differently ({warning.kind}).
            </li>
          ))}
        </ul>
      )}
      {preview.applicable ? null : (
        <p role="status">
          This file cannot be applied
          {preview.entries.length === 0 && preview.issues.length === 0
            ? ": it holds no entry."
            : ". Correct the file and preview it again. Nothing was written."}
        </p>
      )}
    </>
  );
}

const OUTCOME: Readonly<Record<string, string>> = {
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
  conflict: "conflict: not written",
  rejected: "rejected: not written",
  uncertain: "uncertain: whether it was written is not known",
  not_attempted: "not attempted",
};

interface Entry {
  ordinal: number;
  name: string;
  outcome: string;
}

/** The entries an import's result names, when it has a result. */
function entriesOf(operation: OperationResponse): Entry[] {
  const listed = operation.result?.entries;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown): Entry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { ordinal, name, outcome } = entry as Record<string, unknown>;
    return typeof ordinal === "number" && typeof name === "string" && typeof outcome === "string"
      ? [{ ordinal, name, outcome }]
      : [];
  });
}

const was = (count: number): string => (count === 1 ? "was" : "were");

function Result(props: { operation: OperationResponse }) {
  const { operation } = props;
  const entries = entriesOf(operation);
  const written = entries.filter(
    (entry) => entry.outcome === "created" || entry.outcome === "updated",
  );
  const unchanged = entries.filter((entry) => entry.outcome === "unchanged");
  const failed = entries.length - written.length - unchanged.length;
  const waiting = operation.state === "awaiting_input";
  return (
    <section className="panel" role="status">
      <h3>Result</h3>
      <p>State of the import: {operation.state.replaceAll("_", " ")}</p>
      <p className="hint">
        Operation <code>{operation.operationId}</code>
      </p>
      {waiting ? (
        <p>
          The server stopped before the end of the file and waits for the same file. The page did
          not keep the file: choose it again under &quot;Imports waiting for their file&quot; to
          finish. What was written so far stays written.
        </p>
      ) : null}
      {operation.state === "uncertain" ? (
        <p>
          The outcome of one entry is not known. Do not import the file a second time: an operator
          settles this from the host (runbook reconciliation.md).
        </p>
      ) : null}
      {entries.length === 0 ? null : (
        <>
          <p>
            {written.length} of {entries.length} {entries.length === 1 ? "entry" : "entries"}{" "}
            {was(written.length)} written.
            {unchanged.length === 0
              ? ""
              : ` ${String(unchanged.length)} ${was(unchanged.length)} unchanged.`}
            {failed === 0 ? "" : ` ${String(failed)} ${was(failed)} not.`}
          </p>
          <div className="scroll">
            <table aria-label="Result of the import">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.ordinal}>
                    <th scope="row">{entry.name}</th>
                    <td>{OUTCOME[entry.outcome] ?? entry.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Resume(props: {
  at: At;
  waiting: Waiting;
  onResult: (operation: OperationResponse) => void;
}) {
  const { at, waiting } = props;
  const control = useSessionControl();
  const source = useSource();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const resume = async (): Promise<void> => {
    if (busy) return;
    setFailure(null);
    const taken = await source.take();
    if ("problem" in taken) {
      setProblem(taken.problem);
      return;
    }
    setProblem(null);
    setBusy(true);
    const result = await callSecret("import.resume", {
      params: { ...at, operation: waiting.operationId },
      body: taken.bytes,
    });
    setBusy(false);
    if (result.ok) props.onResult(result.body);
    else if (!control.lost(result.failure)) setFailure(result.failure);
  };

  return (
    <div className="panel">
      <p>
        Started <Time at={waiting.createdAt} />, operation <code>{waiting.operationId}</code>. The
        server stopped before the end of its file. Choose the same file again: the server compares
        it with the one the import was started with, and writes only what is still missing.
      </p>
      <SourceFields source={source} problem={problem} />
      {failure === null ? null : (
        <>
          {isCode(failure, "validation_failed") ? (
            <p>
              The server refused this file: it is not the file this import was started with. Nothing
              more was written.
            </p>
          ) : null}
          <ErrorPanel failure={failure} action="resume the import" />
        </>
      )}
      <div className="actions">
        <button type="button" onClick={() => void resume()} disabled={busy}>
          Resume
        </button>
      </div>
    </div>
  );
}

function ImportPanel(props: { at: At; userId: string }) {
  const { at, userId } = props;
  const client = useQueryClient();
  const control = useSessionControl();
  const action = useAction();
  const source = useSource();
  // The file, for as long as this screen needs it.
  const bytes = useRef<Bytes | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preview, setPreview] = useState<ImportPreviewBody | null>(null);
  const [result, setResult] = useState<OperationResponse | null>(null);

  const waiting = useQuery({
    queryKey: [userId, at.org, "imports-waiting", at.project, at.env],
    queryFn: async () => {
      const body = await need(
        call("operations.list", {
          params: at,
          query: { state: "unfinished", limit: LIMITS.listing.maxLimit },
        }),
      );
      return body.operations.filter((row) => row.state === "awaiting_input" && row.mine);
    },
  });

  const startOver = (): void => {
    bytes.current = null;
    setPreview(null);
    setResult(null);
    setFailure(null);
    setProblem(null);
    action.clear();
  };
  const finished = (operation: OperationResponse): void => {
    bytes.current = null;
    setPreview(null);
    setResult(operation);
    void client.invalidateQueries({ queryKey: [userId, at.org] });
  };

  const look = async (): Promise<void> => {
    if (busy) return;
    setFailure(null);
    const taken = await source.take();
    if ("problem" in taken) {
      setProblem(taken.problem);
      return;
    }
    setProblem(null);
    setBusy(true);
    const answer = await callSecret("import.preview", { params: at, body: taken.bytes });
    setBusy(false);
    if (!answer.ok) {
      if (!control.lost(answer.failure)) setFailure(answer.failure);
      return;
    }
    bytes.current = answer.body.applicable ? taken.bytes : null;
    setPreview(answer.body);
  };

  const apply = async (): Promise<void> => {
    const file = bytes.current;
    const previewId = preview?.previewId ?? null;
    if (file === null || previewId === null) return;
    // A 202 is read here: the result below prints the state the answer carries, and follows it.
    const answer = await action.run(
      `import.apply ${previewId}`,
      (key) =>
        callSecret("import.apply", {
          params: { ...at, preview: previewId },
          body: file,
          idempotencyKey: key,
        }),
      { unfinished: "caller" },
    );
    if (answer.ok) finished(answer.body);
  };

  return (
    <section aria-labelledby="import-title">
      <h2 id="import-title">Import</h2>
      {result !== null ? (
        <>
          <Result operation={result} />
          <div className="actions">
            <button type="button" onClick={startOver}>
              Import another file
            </button>
          </div>
        </>
      ) : preview !== null ? (
        <>
          <Preview preview={preview} />
          {action.failure === null ? null : (
            <ErrorPanel failure={action.failure} action="apply the import" />
          )}
          <div className="actions">
            {preview.applicable && preview.previewId !== null ? (
              <button type="button" onClick={() => void apply()} disabled={action.busy}>
                Apply import
              </button>
            ) : null}
            <button type="button" onClick={startOver} disabled={action.busy}>
              Start over
            </button>
          </div>
          {preview.applicable ? (
            <p className="hint">
              The file is held by this page until the import is applied or you leave this screen.
              The preview is valid until <Time at={preview.expiresAt} />.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p>
            A dotenv file is first previewed: the server says for each name whether it is new,
            changed or unchanged, and writes nothing. No value is shown here.
          </p>
          <SourceFields source={source} problem={problem} />
          {failure === null ? null : <ErrorPanel failure={failure} action="preview the file" />}
          <div className="actions">
            <button type="button" onClick={() => void look()} disabled={busy}>
              Preview
            </button>
          </div>
        </>
      )}

      {waiting.isError ? (
        <ErrorPanel
          failure={failureOf(waiting.error)}
          action="read the imports that wait"
          onReload={() => void waiting.refetch()}
        />
      ) : null}
      {waiting.data === undefined || waiting.data.length === 0 ? null : (
        <section aria-labelledby="waiting-title">
          <h3 id="waiting-title">Imports waiting for their file</h3>
          {waiting.data.map((row) => (
            <Resume key={row.operationId} at={at} waiting={row} onResult={finished} />
          ))}
        </section>
      )}
    </section>
  );
}

export function ImportExport() {
  const { organization, project, environment, userId } = useScope();
  if (organization === null || project === null || environment === null) return null;
  const at: At = { org: organization.id, project: project.id, env: environment.id };
  const readable = environment.state !== "needs_review" && environment.state !== "pending";
  return (
    <>
      <h1>Import and export</h1>
      <p className="hint">
        {project.name} / {environment.name}
      </p>
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      {environment.state === "active" ? <ImportPanel at={at} userId={userId} /> : null}
      {readable ? <ExportPanel at={at} environmentName={environment.name} /> : null}
    </>
  );
}
