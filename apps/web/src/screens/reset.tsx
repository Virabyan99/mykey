// Completing an operator's reset (FR-1.04, P-51, P-137). The link's token
// was taken out of the address before anything was rendered
// (reset-link.ts); here it lives in a forgetting holder for as long as the
// link itself is valid, and goes with the first change of address.
//
// Every refusal of a reset is one answer (an unknown, expired, replaced or
// used link, a wrong code), so the page has one text for it.
import { LIMITS, PASSWORD_MIN_CHARACTERS, checkPassword } from "@mykey/contracts";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { call } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { Link, navigate } from "../router.tsx";
import { setFlow } from "../state/flow.ts";
import { takeResetLink, type ResetLink } from "../state/reset-link.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { Field } from "../ui/Field.tsx";

export const PASSWORD_RULE = `At least ${String(PASSWORD_MIN_CHARACTERS)} characters. A long phrase is fine.`;

export function Reset() {
  const [link, setLink, clearLink] = useEphemeral<ResetLink>(LIMITS.reset.linkSeconds * 1000, {
    clearOnHide: false,
  });
  const [looked, setLooked] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    const taken = takeResetLink();
    if (taken !== null) setLink(taken);
    setLooked(true);
  }, [setLink]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (link === null || first.current === null || second.current === null || busy) return;
    const newPassword = first.current.value;
    if (newPassword !== second.current.value) {
      setProblem("The two passwords are not the same.");
      return;
    }
    if (!checkPassword(newPassword).ok) {
      setProblem(`This password is not accepted. ${PASSWORD_RULE}`);
      return;
    }
    setProblem(null);
    setBusy(true);
    const given = code.current?.value.trim() ?? "";
    const result = await call("auth.reset.complete", {
      body: { token: link.token, newPassword, ...(given === "" ? {} : { code: given }) },
    });
    first.current.value = "";
    second.current.value = "";
    if (code.current !== null) code.current.value = "";
    setBusy(false);
    if (result.ok) {
      clearLink();
      if (result.body.next === "enroll") {
        setFlow({ enrolAfterReset: true, notice: null });
        navigate("/enroll");
      } else {
        setFlow({ enrolAfterReset: false, notice: "password_reset" });
        navigate("/sign-in");
      }
      return;
    }
    if (result.failure.kind === "api" && result.failure.code === "unauthenticated") {
      setRefused(true);
      setFailure(null);
      return;
    }
    if (result.failure.kind === "api" && result.failure.code === "validation_failed") {
      setProblem(`This password is not accepted. ${PASSWORD_RULE}`);
      return;
    }
    setRefused(false);
    setFailure(result.failure);
  };

  if (!looked) return null;
  if (link === null) {
    return (
      <main className="narrow">
        <h1>Reset your account</h1>
        <p>
          This page opens from a reset link. A link works once, for 15 minutes, in the tab it was
          opened in. The operator makes a new one (runbook operator-accounts.md).
        </p>
        <p>
          <Link to="/sign-in">Sign in</Link>
        </p>
      </main>
    );
  }
  return (
    <main className="narrow">
      <h1>Reset your account</h1>
      <p>
        {link.kind === "mfa"
          ? "Choose a new password. Right after it you set up a new authenticator; the old one and the old recovery codes stop working."
          : "Choose a new password and confirm with your authenticator or one recovery code."}
      </p>
      <form
        method="post"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          required
          inputRef={first}
          hint={PASSWORD_RULE}
          error={problem}
        />
        <Field
          label="New password again"
          type="password"
          autoComplete="new-password"
          maxLength={1024}
          required
          inputRef={second}
        />
        {link.kind === "password" ? (
          <Field
            label="Authenticator or recovery code"
            type="text"
            autoComplete="one-time-code"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={64}
            required
            inputRef={code}
          />
        ) : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            Set the new password
          </button>
        </div>
      </form>
      {refused ? (
        <div className="panel panel-error" role="alert">
          <p>
            This was not accepted: the link is unknown, used, expired or replaced by a newer one, or
            the code is wrong. Nothing was changed.
          </p>
          <p>The operator makes a new link (runbook operator-accounts.md).</p>
        </div>
      ) : null}
      {failure === null ? null : <ErrorPanel failure={failure} action="reset the account" />}
    </main>
  );
}
