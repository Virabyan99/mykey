// The card of signing in, enrolment and reset (Run 9.0 Task D): the MyKey
// mark, which step of how many this is, and the step itself. Nothing of the
// workspace is shown or requested here.
import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

export function AuthCard(props: { step?: string; children: ReactNode }) {
  return (
    <main className="narrow">
      <div className="auth-card">
        <p className="brand">
          <Icon name="keyRound" large />
          MyKey
        </p>
        {props.step === undefined ? null : <p className="step-of">{props.step}</p>}
        {props.children}
      </div>
    </main>
  );
}
