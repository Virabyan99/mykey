// Signing in: the password, then a code (FR-1.01, FR-1.02, P-137). Anyone
// without a complete session sees these on every path, and the address
// stays as it was, so signing in leads to where the owner was going.
//
// A refused sign-in has one text for every cause, as the server has one
// answer for every cause. The password is read from its field when the form
// is sent and the field is emptied at once; it is never in the page's state.
import { AuthCard } from "../ui/AuthCard.tsx";
import { useRef, useState, type SyntheticEvent } from "react";
import { signIn, signOut, verifyRecovery, verifyTotp } from "../api/auth.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { navigate } from "../router.tsx";
import { useFlow, type Notice } from "../state/flow.ts";
import { useSessionControl } from "../state/session.tsx";
import { CODE_INPUT, Field } from "../ui/Field.tsx";

const NOTICES: Readonly<Record<Notice, string>> = {
  session_ended: "Your session ended. Sign in again.",
  signed_out: "You are signed out.",
  password_reset: "The new password is set. Sign in with it.",
  authenticator_reset:
    "The new authenticator is active. Sign in with your new password and a code from it.",
};

const isRefusal = (failure: Failure): boolean =>
  failure.kind === "api" && failure.code === "unauthenticated";

export function SignIn() {
  const control = useSessionControl();
  const { notice } = useFlow();
  const password = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const field = password.current;
    if (field === null || busy) return;
    setBusy(true);
    const result = await signIn(email.trim(), field.value);
    field.value = "";
    setBusy(false);
    if (result.ok) {
      setRefused(false);
      setFailure(null);
      await control.refresh();
      return;
    }
    setRefused(isRefusal(result.failure));
    setFailure(isRefusal(result.failure) ? null : result.failure);
  };

  return (
    <AuthCard step="Step 1 of 2: your password">
      <h1>Sign in</h1>
      {notice === null ? null : <p role="status">{NOTICES[notice]}</p>}
      <p>The workspace opens after your password and a code from your authenticator app.</p>
      <form
        method="post"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label="E-mail address"
          type="email"
          name="email"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={320}
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          maxLength={1024}
          required
          inputRef={password}
        />
        <div className="actions">
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </div>
      </form>
      {refused ? (
        <div className="panel panel-error" role="alert">
          <p>
            Sign-in was not accepted. The e-mail address or the password is wrong, or this account
            cannot sign in at the moment.
          </p>
          <p>
            After a restore from a backup every account needs a reset link from the operator
            (runbook restore.md). A lost password is replaced the same way (runbook
            operator-accounts.md).
          </p>
        </div>
      ) : null}
      {failure === null ? null : <ErrorPanel failure={failure} action="sign in" />}
    </AuthCard>
  );
}

/** The second step of a session that has passed the password only. */
export function SecondStep() {
  const control = useSessionControl();
  const code = useRef<HTMLInputElement>(null);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const field = code.current;
    if (field === null || busy) return;
    setBusy(true);
    const value = field.value.trim();
    const result = await (recovery ? verifyRecovery(value) : verifyTotp(value));
    field.value = "";
    setBusy(false);
    if (result.ok) {
      await control.refresh();
      return;
    }
    if (isRefusal(result.failure)) {
      setRefused(true);
      setFailure(null);
      // The password step may have run out (ten minutes): the server says which.
      await control.refresh();
      return;
    }
    // The account has no active authenticator yet: it is set up first.
    if (result.failure.kind === "api" && result.failure.code === "state_conflict") {
      navigate("/enroll");
      return;
    }
    setRefused(false);
    setFailure(result.failure);
  };

  // "Signed out" is said only when the server has ended the session.
  const leave = async (): Promise<void> => {
    const result = await signOut();
    if (result.ok) control.drop("signed_out");
    else setFailure(result.failure);
  };

  return (
    <AuthCard step="Step 2 of 2: your code">
      <h1>Enter your code</h1>
      <p>Your password was accepted. The workspace opens after the second step.</p>
      <form
        method="post"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {recovery ? (
          <Field
            key="recovery"
            label="Recovery code"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={64}
            required
            inputRef={code}
            hint="One of the ten codes from when the authenticator was set up. Each works once."
            error={refused ? "That code was not accepted." : null}
          />
        ) : (
          <Field
            key="totp"
            label="Code from your authenticator app"
            inputRef={code}
            {...CODE_INPUT}
            error={
              refused ? "That code was not accepted. A code works once: use the next one." : null
            }
          />
        )}
        <div className="actions">
          <button type="submit" disabled={busy}>
            Verify
          </button>
        </div>
      </form>
      {failure === null ? null : <ErrorPanel failure={failure} action="complete the sign-in" />}
      <div className="actions other">
        <button
          type="button"
          onClick={() => {
            setRecovery(!recovery);
            setRefused(false);
          }}
        >
          {recovery ? "Use the authenticator app" : "Use a recovery code"}
        </button>
        <button
          type="button"
          onClick={() => {
            navigate("/enroll");
          }}
        >
          Set up an authenticator
        </button>
        <button
          type="button"
          onClick={() => {
            void leave();
          }}
        >
          Sign out
        </button>
      </div>
      <p className="hint">
        "Set up an authenticator" is for an account that has none yet: a new account, or one the
        operator has reset.
      </p>
    </AuthCard>
  );
}
