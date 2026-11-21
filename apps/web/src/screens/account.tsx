// The account's own security (FR-1.05 to FR-1.08): its sessions, its
// password, its recovery codes. The password change and new recovery codes
// need a code from the last ten minutes; when the server says so, the
// step-up dialog asks for one, and the owner then sends the change again
// with the same button. The page never sends it for them.
import { PAGES } from "../copy/pages.ts";
import { PageHeader } from "../ui/PageHeader.tsx";
import { ACTIONS } from "../copy/actions.ts";
import { useQuery } from "@tanstack/react-query";
import { LIMITS } from "@mykey/contracts";
import { useRef, useState, type SyntheticEvent } from "react";
import {
  changePassword,
  listSessions,
  regenerateRecovery,
  revokeSession,
  revokeSessions,
  type SessionRow,
} from "../api/auth.ts";
import { failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { useScope } from "../state/scope.tsx";
import { useSessionControl } from "../state/session.tsx";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { ConfirmButton } from "../ui/Confirm.tsx";
import { Field } from "../ui/Field.tsx";
import { RecoveryCodes } from "../ui/Secret.tsx";
import { Loading } from "../ui/StateBadge.tsx";
import { StepUp } from "../ui/StepUp.tsx";
import { Time } from "../ui/Time.tsx";
import { PASSWORD_RULE } from "./reset.tsx";

const needsFreshCode = (failure: Failure): boolean =>
  failure.kind === "api" && failure.code === "fresh_verification_required";

function Sessions() {
  const { userId } = useScope();
  const control = useSessionControl();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const sessions = useQuery({
    queryKey: [userId, null, "sessions"],
    queryFn: () => need(listSessions()),
    // Another device may sign in or out at any time: this list is read when the page is opened.
    staleTime: 0,
  });

  const end = async (row: SessionRow): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await revokeSession(row.id);
    setBusy(false);
    if (!result.ok) {
      if (!control.lost(result.failure)) setFailure(result.failure);
      return;
    }
    setFailure(null);
    if (row.current) control.drop("signed_out");
    else await sessions.refetch();
  };

  const endAll = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await revokeSessions();
    setBusy(false);
    if (result.ok) control.drop("signed_out");
    else if (!control.lost(result.failure)) setFailure(result.failure);
  };

  return (
    <section className="card">
      <h2>Sessions</h2>
      <p>
        Every place this account is signed in. A session ends by itself after{" "}
        {LIMITS.session.idleSeconds / 60} minutes without use and at the latest after{" "}
        {LIMITS.session.absoluteSeconds / 3600} hours.
      </p>
      {sessions.isPending ? <Loading what="the sessions" /> : null}
      {sessions.isError ? (
        <ErrorPanel
          failure={failureOf(sessions.error)}
          action="list the sessions"
          onReload={() => void sessions.refetch()}
        />
      ) : null}
      {sessions.data === undefined ? null : (
        <div className="scroll">
          <table aria-label="Sessions">
            <thead>
              <tr>
                <th scope="col">Browser or client</th>
                <th scope="col">Signed in</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.client ?? "unknown"}
                    {row.current ? <strong> (this session)</strong> : null}
                  </td>
                  <td>
                    <Time at={row.createdAt} />
                  </td>
                  <td>
                    <Time at={row.lastActivityAt} />
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void end(row);
                      }}
                    >
                      End session
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure === null ? null : <ErrorPanel failure={failure} action="end the session" />}
      <ConfirmButton
        label="End every session"
        confirm="Yes, end every session"
        warning={ACTIONS.endEverySession}
        disabled={busy}
        onConfirm={() => {
          void endAll();
        }}
      />
    </section>
  );
}

const ended = (count: number): string =>
  count === 0
    ? "No other session was open."
    : `${String(count)} other ${count === 1 ? "session" : "sessions"} ended.`;

function Password() {
  const control = useSessionControl();
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (current.current === null || next.current === null || busy) return;
    setBusy(true);
    setStatus(null);
    const result = await changePassword(current.current.value, next.current.value);
    setBusy(false);
    setProblem(null);
    setWrong(false);
    setFailure(null);
    if (result.ok) {
      current.current.value = "";
      next.current.value = "";
      setStatus(`The password is changed. ${ended(result.body.revokedSessions)}`);
      return;
    }
    // The fields keep what was typed: the owner sends the same change after the code.
    if (needsFreshCode(result.failure)) {
      setAsking(true);
      return;
    }
    if (result.failure.kind === "api" && result.failure.code === "validation_failed") {
      setProblem(`This password is not accepted. ${PASSWORD_RULE}`);
      return;
    }
    // A wrong current password and an ended session are one answer: ask which it was.
    if (result.failure.kind === "api" && result.failure.code === "unauthenticated") {
      current.current.value = "";
      setWrong(true);
      await control.refresh();
      return;
    }
    setFailure(result.failure);
  };

  return (
    <section className="card">
      <h2>Password</h2>
      <p>Changing the password ends every other session of this account.</p>
      <form
        method="post"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          required
          inputRef={current}
          error={wrong ? "The current password was not accepted." : null}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          required
          inputRef={next}
          hint={PASSWORD_RULE}
          error={problem}
        />
        <div className="actions">
          <button type="submit" disabled={busy}>
            Change password
          </button>
        </div>
      </form>
      {status === null ? null : <p role="status">{status}</p>}
      {failure === null ? null : <ErrorPanel failure={failure} action="change the password" />}
      <StepUp
        open={asking}
        action="change the password"
        onDone={(confirmed) => {
          setAsking(false);
          setStatus(confirmed ? "Confirmed. Send the change again." : null);
        }}
      />
    </section>
  );
}

function Recovery() {
  const control = useSessionControl();
  const [codes, setCodes, clearCodes] = useEphemeral<string[]>(
    LIMITS.session.freshTotpSeconds * 1000,
    { clearOnHide: false },
  );
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const make = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const result = await regenerateRecovery();
    setBusy(false);
    setFailure(null);
    if (result.ok) {
      setCodes(result.body.recoveryCodes);
      return;
    }
    if (needsFreshCode(result.failure)) {
      setAsking(true);
      return;
    }
    if (!control.lost(result.failure)) setFailure(result.failure);
  };

  return (
    <section className="card">
      <h2>Recovery codes</h2>
      <p>
        Ten codes, each good for one sign-in without the authenticator. The page cannot show the
        codes you have; it can only replace them.
      </p>
      {codes === null ? (
        <ConfirmButton
          label="Make new recovery codes"
          confirm="Yes, replace my recovery codes"
          warning={ACTIONS.newRecoveryCodes}
          disabled={busy}
          onConfirm={() => {
            void make();
          }}
        />
      ) : (
        <RecoveryCodes
          codes={codes}
          onSaved={() => {
            clearCodes();
            setStatus("The new recovery codes are in force.");
          }}
        />
      )}
      {status === null ? null : <p role="status">{status}</p>}
      {failure === null ? null : <ErrorPanel failure={failure} action="make new recovery codes" />}
      <StepUp
        open={asking}
        action="make new recovery codes"
        onDone={(confirmed) => {
          setAsking(false);
          setStatus(confirmed ? "Confirmed. Ask for the new codes again." : null);
        }}
      />
    </section>
  );
}

export function Account() {
  return (
    <>
      <PageHeader page={PAGES.account} />
      <Sessions />
      <Password />
      <Recovery />
    </>
  );
}
