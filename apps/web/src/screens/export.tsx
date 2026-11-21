// Export (FR-1.37, P-138): every live value of the environment in one file.
// It needs a fresh code and a typed confirmation. The page offers the file
// for saving only after api/export.ts read the whole answer and checked its
// digest; until it is saved it lives in the forgetting holder, like every
// other secret of the page, and after the save the page has none of it.
import { useState } from "react";
import { exportEnvironment, type ExportedFile } from "../api/export.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { EPHEMERAL_TTL_MS } from "../state/ephemeral.ts";
import { useSessionControl } from "../state/session.tsx";
import { isCode } from "../state/use-action.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { StepUp } from "../ui/StepUp.tsx";
import type { At } from "./secret-value.tsx";

const OUTSIDE =
  "The file is outside MyKey from the moment it is saved: MyKey cannot protect it, cannot see who reads it and cannot take it back.";

/** Hands the bytes to the browser's own save, and lets go of the address right after. */
function save(file: ExportedFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has started the save by now; the address must not outlive it.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

export function ExportPanel(props: { at: At; environmentName: string }) {
  const control = useSessionControl();
  const [file, hold, drop] = useEphemeral<ExportedFile>();
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await exportEnvironment(props.at);
    setBusy(false);
    setConfirming(false);
    if (result.kind === "file") {
      hold(result.file);
      return;
    }
    if (result.kind === "incomplete") {
      setIncomplete(true);
      return;
    }
    if (control.lost(result.failure)) return;
    // The code is older than ten minutes: the owner proves presence, then asks again.
    if (isCode(result.failure, "fresh_verification_required")) setAsking(true);
    else setFailure(result.failure);
  };

  return (
    <section aria-labelledby="export-title">
      <h2 id="export-title">Export</h2>
      <p>
        An export writes every live value of this environment into one dotenv file. It needs a code
        from your authenticator of the last ten minutes, and it is recorded in the audit log with
        the number of names it holds.
      </p>
      {note === null ? null : <p role="status">{note}</p>}
      {failure === null ? null : <ErrorPanel failure={failure} action="export the environment" />}
      {incomplete ? (
        <p className="field-error" role="alert">
          The export was incomplete. Nothing was saved: the answer did not arrive whole, so the page
          kept none of it. Export again.
        </p>
      ) : null}
      {file === null ? (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setNote(null);
              setFailure(null);
              setIncomplete(false);
              setConfirming(true);
            }}
          >
            Export this environment
          </button>
        </div>
      ) : (
        <section className="panel">
          <p role="status">
            The export is complete: {file.bytes.length.toLocaleString("en-US")} bytes, checked
            against the server&apos;s digest. It is kept here for {String(EPHEMERAL_TTL_MS / 1000)}{" "}
            seconds, or until you leave this page or this tab.
          </p>
          <p>{OUTSIDE}</p>
          {file.warnings === null ? (
            <p>
              {file.warningCount} names hold a value another dotenv loader would read differently;
              there are too many to list here.
            </p>
          ) : file.warnings.length === 0 ? null : (
            <ul aria-label="Warnings">
              {file.warnings.map((warning) => (
                <li key={`${warning.name} ${warning.loader} ${warning.kind}`}>
                  <code>{warning.name}</code>: the loader {warning.loader} would read this value
                  differently ({warning.kind}).
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                save(file);
                drop();
                setNote(
                  `The file is saved by your browser as ${file.fileName}. It is outside MyKey now, and this page has let go of it.`,
                );
              }}
            >
              Save the file
            </button>
            <button type="button" onClick={drop}>
              Discard
            </button>
          </div>
        </section>
      )}
      {confirming ? (
        <ConfirmDialog
          title={`Export ${props.environmentName}`}
          name={props.environmentName}
          confirm="Export"
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => {
            setConfirming(false);
          }}
        >
          <p>Every live value of this environment is written into one file.</p>
          <p>{OUTSIDE}</p>
        </ConfirmDialog>
      ) : null}
      <StepUp
        open={asking}
        action="export this environment"
        onDone={(confirmed) => {
          setAsking(false);
          if (confirmed) setNote("Confirmed. Export again.");
        }}
      />
    </section>
  );
}
