// Setting up the authenticator (FR-1.02, FR-1.03, P-135, P-138). The key and
// the ten recovery codes are each shown once. Both live in a forgetting
// holder that keeps them while the tab is hidden, because the owner has to
// leave the tab to use them (an authenticator, a password manager); they go
// when the owner confirms, when the address changes, and after ten minutes.
//
// No QR code (P-135): the key is shown in groups of four beside the
// otpauth:// address as text.
import { AuthCard } from "../ui/AuthCard.tsx";
import { LIMITS } from "@mykey/contracts";
import { useRef, useState, type SyntheticEvent } from "react";
import { activateTotp, enrollTotp } from "../api/auth.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { navigate } from "../router.tsx";
import { setFlow, useFlow } from "../state/flow.ts";
import { useSessionControl } from "../state/session.tsx";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { CODE_INPUT, Field } from "../ui/Field.tsx";
import { CopyButton, RecoveryCodes, SecretLine } from "../ui/Secret.tsx";

const HOLD_MS = LIMITS.session.incompleteChallengeSeconds * 1000;
const PATIENT = { clearOnHide: false } as const;

const grouped = (key: string): string => (key.match(/.{1,4}/g) ?? [key]).join(" ");

export function Enroll() {
  const control = useSessionControl();
  const { enrolAfterReset } = useFlow();
  const code = useRef<HTMLInputElement>(null);
  const [key, setKey, clearKey] = useEphemeral<{ secret: string; uri: string }>(HOLD_MS, PATIENT);
  const [codes, setCodes, clearCodes] = useEphemeral<string[]>(HOLD_MS, PATIENT);
  const [activated, setActivated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const create = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await enrollTotp();
    setBusy(false);
    setRefused(false);
    if (result.ok) {
      setFailure(null);
      setKey(result.body);
      return;
    }
    setFailure(result.failure);
  };

  const activate = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const field = code.current;
    if (field === null || busy) return;
    setBusy(true);
    const result = await activateTotp(field.value.trim());
    field.value = "";
    setBusy(false);
    if (result.ok) {
      clearKey();
      setRefused(false);
      setFailure(null);
      setCodes(result.body.recoveryCodes);
      setActivated(true);
      return;
    }
    if (result.failure.kind === "api" && result.failure.code === "unauthenticated") {
      setRefused(true);
      setFailure(null);
      return;
    }
    setRefused(false);
    setFailure(result.failure);
  };

  // The server has made the session complete at activation; the page asks only now.
  // At the end of a reset it has ended every session instead (P-51): the sign-in
  // form comes back, and says why.
  const finish = async (): Promise<void> => {
    clearCodes();
    await control.refresh();
    setFlow({ enrolAfterReset: false, notice: enrolAfterReset ? "authenticator_reset" : null });
    navigate("/", { replace: true });
  };

  if (activated) {
    return (
      <AuthCard step="Set up: one code from the app">
        <h1>Set up your authenticator</h1>
        <p role="status">The authenticator is active.</p>
        {codes === null ? (
          <section className="panel">
            <p>
              The recovery codes are no longer shown. You can make new ones on the Account page; the
              old ones then stop working.
            </p>
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  void finish();
                }}
              >
                Continue
              </button>
            </div>
          </section>
        ) : (
          <RecoveryCodes
            codes={codes}
            onSaved={() => {
              void finish();
            }}
          />
        )}
      </AuthCard>
    );
  }

  const conflict = failure?.kind === "api" && failure.code === "state_conflict";
  return (
    <AuthCard step="Set up: one code from the app">
      <h1>Set up your authenticator</h1>
      {key === null ? (
        <>
          <p>
            An authenticator app makes the six-digit codes this account is signed in with. Creating
            a setup key replaces any key that was created before and not activated.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void create();
              }}
            >
              Create a setup key
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Enter this key in your authenticator app (time-based, six digits, 30 seconds), then type
            the code the app shows. The key is shown only now.
          </p>
          <SecretLine label="Setup key" text={key.secret} shown={grouped(key.secret)} />
          <CopyButton text={key.secret} label="Copy the key" />
          <SecretLine label="Address for an authenticator app" text={key.uri} />
          <form
            method="post"
            onSubmit={(event) => {
              void activate(event);
            }}
          >
            <Field
              label="Code from your authenticator app"
              inputRef={code}
              {...CODE_INPUT}
              error={
                refused ? "That code was not accepted. A code works once: use the next one." : null
              }
            />
            <div className="actions">
              <button type="submit" disabled={busy}>
                Activate
              </button>
            </div>
          </form>
        </>
      )}
      {failure === null ? null : conflict ? (
        <section className="panel panel-error" role="alert">
          <h2>This account already has an authenticator</h2>
          <p>Or the time for this step is over. Nothing was changed.</p>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                navigate("/sign-in");
              }}
            >
              Enter a code instead
            </button>
          </div>
        </section>
      ) : (
        <ErrorPanel failure={failure} action="set up the authenticator" />
      )}
    </AuthCard>
  );
}
