// Machine credentials of one environment (FR-1.41 to FR-1.44, P-138). The
// inventory is what the server's catalog says, and "not known" where it says
// nothing. A token exists in the page exactly once: in the answer that made
// it, held by the forgetting holder for 120 seconds and gone when the owner
// hides the tab, leaves the screen or signs out. It cannot be shown again,
// and the page says so before and after. A row whose outcome is open is
// settled by an operator: the page offers nothing on it.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, checkProjectName, type CredentialView } from "@mykey/contracts";
import { useId, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Field } from "../ui/Field.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { CopyButton, SecretLine } from "../ui/Secret.tsx";
import { OperationsLink } from "../ui/OperationsLink.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { StepUp } from "../ui/StepUp.tsx";
import { Time } from "../ui/Time.tsx";
import { useNow, type At } from "./secret-value.tsx";

/** A token stays on the screen longer than a value: it has to be carried to its consumer. */
const TOKEN_TTL_MS = 120_000;
const DAY_SECONDS = 86_400;
const MAX_DAYS = Math.floor(LIMITS.machineToken.maxTtlSeconds / DAY_SECONDS);
const WARNING_DAYS = Math.floor(LIMITS.machineToken.expiryWarningSeconds / DAY_SECONDS);
const RUNBOOK = "docs/runbooks/machine-credentials.md";

const NAME_RULE = `A credential name is ${String(LIMITS.project.nameMinCodePoints)} to ${String(LIMITS.project.nameMaxCodePoints)} characters, not only spaces and without control characters.`;
const DAYS_RULE = `A lifetime is a whole number of days from 1 to ${String(MAX_DAYS)}.`;

interface Shown {
  token: string;
  name: string;
  until: number;
}

const NOT_KNOWN = <span className="muted">not known</span>;

function TokenPanel(props: { shown: Shown; onHide: () => void }) {
  const { shown } = props;
  const title = useId();
  const now = useNow(true);
  // The clock of the countdown may be a second old; it is never older than the issue.
  const left = Math.ceil((shown.until - Math.max(now, shown.until - TOKEN_TTL_MS)) / 1000);
  return (
    <section className="panel" aria-labelledby={title}>
      <h2 id={title}>The token, shown once</h2>
      <SecretLine label="Token" text={shown.token} />
      <p>
        This is the token of {shown.name}. It cannot be shown again: the service keeps no copy of
        it. Put it where its consumer reads it now (<code>{RUNBOOK}</code>).
      </p>
      <p>
        Hidden in {Math.max(0, left)} s, or as soon as you leave this page or this tab. If it is
        lost before it reached its consumer, revoke this credential and issue a new one.
      </p>
      <div className="actions">
        <CopyButton text={shown.token} label="Copy token" />
        <button type="button" onClick={props.onHide}>
          Hide now
        </button>
      </div>
    </section>
  );
}

function IssueForm(props: {
  at: At;
  /** The token of the answer, or null when it arrived while the tab was hidden. */
  onIssued: (name: string, token: string | null) => void;
  /** Any answer or none: the catalog may have a new row. */
  onAnswer: () => void;
  onCancel: () => void;
  /** Why nothing can be issued now, or null. The last answer of the form stays readable. */
  blocked: string | null;
}) {
  const { at, blocked } = props;
  const action = useAction();
  const [name, setName] = useState("");
  const [days, setDays] = useState(String(MAX_DAYS));
  const [problems, setProblems] = useState<{ name: string | null; days: string | null }>({
    name: null,
    days: null,
  });
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setNote(null);
    const wanted = name.trim().normalize("NFC");
    const lifetime = /^[0-9]{1,3}$/.test(days.trim()) ? Number(days.trim()) : 0;
    const found = {
      name: checkProjectName(wanted).ok ? null : NAME_RULE,
      days: lifetime >= 1 && lifetime <= MAX_DAYS ? null : DAYS_RULE,
    };
    setProblems(found);
    if (found.name !== null || found.days !== null) return;
    if (blocked !== null) return;
    const result = await action.run(
      `credentials.issue ${at.env} ${wanted} ${String(lifetime)}`,
      (key) =>
        callSecret("credentials.issue", {
          params: at,
          body: { name: wanted, ttlSeconds: lifetime * DAY_SECONDS },
          idempotencyKey: key,
        }),
    );
    props.onAnswer();
    if (result.ok) {
      // A token that arrived while nobody could see the tab is not kept.
      props.onIssued(wanted, document.visibilityState === "hidden" ? null : result.body.token);
      return;
    }
    // The code is older than ten minutes: the owner proves presence, then asks again.
    if (isCode(result.failure, "fresh_verification_required")) {
      action.clear();
      setAsking(true);
    }
  };

  return (
    <>
      <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
        <h2>New credential</h2>
        <p>
          A credential lets one consumer read the complete secret set of this environment, and
          nothing else. Its token is shown once, right after it is issued. Issuing needs a code from
          your authenticator of the last ten minutes.
        </p>
        {blocked === null ? null : <p role="status">{blocked}</p>}
        <Field
          label="Name"
          disabled={blocked !== null}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={problems.name}
          hint="Say which consumer it is for, e.g. the server or the pipeline that will hold it."
          autoComplete="off"
        />
        <Field
          label="Lifetime in days"
          disabled={blocked !== null}
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
          }}
          inputMode="numeric"
          error={problems.days}
          hint={`At most ${String(MAX_DAYS)}, which is also the default. A token cannot be renewed: before it ends, a new credential replaces it.`}
          autoComplete="off"
        />
        {note === null ? null : <p role="status">{note}</p>}
        {action.failure === null ? null : (
          <ErrorPanel failure={action.failure} action="issue the credential">
            <OperationsLink failure={action.failure} at={at} />
          </ErrorPanel>
        )}
        <div className="actions">
          {blocked === null ? (
            <button type="submit" disabled={action.busy}>
              Issue credential
            </button>
          ) : null}
          <button type="button" onClick={props.onCancel} disabled={action.busy}>
            {blocked === null ? "Cancel" : "Close"}
          </button>
        </div>
      </form>
      {/* A form of its own: inside the form above, its submit would also be this one's. */}
      <StepUp
        open={asking}
        action="issue a machine credential"
        onDone={(confirmed) => {
          setAsking(false);
          if (confirmed) setNote("Confirmed. Issue the credential again.");
        }}
      />
    </>
  );
}

function RevokeDialog(props: {
  at: At;
  credential: CredentialView;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { at, credential } = props;
  const action = useAction();
  const revoke = async (): Promise<void> => {
    const result = await action.run(`credentials.revoke ${credential.credentialId}`, (key) =>
      call("credentials.revoke", {
        params: { ...at, credential: credential.credentialId },
        body: { confirmed: true },
        idempotencyKey: key,
      }),
    );
    if (result.ok) props.onDone();
  };
  return (
    <ConfirmDialog
      title={`Revoke ${credential.name}`}
      name={credential.name}
      confirm="Revoke"
      busy={action.busy}
      onConfirm={() => void revoke()}
      onCancel={props.onCancel}
    >
      <p>
        The token of this credential is refused from the moment the server answers. A consumer that
        still uses it can no longer read its secrets.
      </p>
      <p>
        A revocation cannot be undone. To give the consumer access again, issue a new credential.
      </p>
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action="revoke the credential">
          <OperationsLink failure={action.failure} at={at} />
        </ErrorPanel>
      )}
    </ConfirmDialog>
  );
}

/** What the page says about a row beyond its state: a warning, or who settles it. */
function RowNote(props: { row: CredentialView }) {
  const { state, expiringSoon } = props.row;
  if (state === "needs_review") {
    return (
      <p className="review">
        Whether a token exists for this credential is not known. An operator settles this from the
        host (<code>{RUNBOOK}</code>).
      </p>
    );
  }
  if (state === "revoking") {
    return (
      <p className="review">
        The revocation has no proven end yet. An operator settles this from the host (
        <code>{RUNBOOK}</code>). Treat the token as still accepted until this row says revoked.
      </p>
    );
  }
  if (state === "issuing") return <p className="hint">The server is issuing it.</p>;
  if (state === "active" && expiringSoon) {
    return (
      <p className="review">
        Expires within {WARNING_DAYS} days. Issue a new credential, move the consumer to it, then
        revoke this one.
      </p>
    );
  }
  return null;
}

function Inventory(props: { at: At; userId: string; scope: string; writable: boolean }) {
  const { at, userId, scope, writable } = props;
  const client = useQueryClient();
  const [shown, show, hide] = useEphemeral<Shown>(TOKEN_TTL_MS);
  const [form, setForm] = useState(false);
  const [revoking, setRevoking] = useState<CredentialView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queryKey = [userId, at.org, "credentials", at.project, at.env];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      need(
        call("credentials.list", {
          params: at,
          query: { limit: LIMITS.listing.defaultLimit, cursor: pageParam },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: [userId, at.org] });
  };

  const rows = list.data?.pages.flatMap((page) => page.credentials) ?? [];
  // One unresolved issuance closes the environment for the next one (the server's rule).
  const blocking = rows.find((row) => row.state === "needs_review" || row.state === "issuing");
  const blocked =
    blocking === undefined
      ? null
      : `No credential can be issued for this environment until ${blocking.name} (${
          blocking.state === "issuing" ? "being issued" : "needs review"
        }) is settled.`;

  return (
    <>
      {shown === null ? null : <TokenPanel shown={shown} onHide={hide} />}
      {notice === null ? null : <p role="status">{notice}</p>}
      {!writable || list.data === undefined ? null : form ? (
        <IssueForm
          at={at}
          blocked={blocked}
          onAnswer={refresh}
          onIssued={(name, token) => {
            setForm(false);
            if (token === null) {
              setNotice(
                `${name} was issued, and its token arrived while this tab was hidden, so it was not kept. It cannot be shown again: revoke ${name} and issue a new credential.`,
              );
              return;
            }
            setNotice(`${name} is issued.`);
            show({ token, name, until: Date.now() + TOKEN_TTL_MS });
          }}
          onCancel={() => {
            setForm(false);
          }}
        />
      ) : blocked !== null ? (
        <p role="status">{blocked}</p>
      ) : (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              hide();
              setForm(true);
            }}
          >
            New credential
          </button>
        </div>
      )}

      {list.isPending ? <Loading what="the credentials" /> : null}
      {list.isError ? (
        <ErrorPanel
          failure={failureOf(list.error)}
          action="read the credentials"
          onReload={() => void list.refetch()}
        />
      ) : null}
      {list.data === undefined ? null : rows.length === 0 ? (
        <p>This environment has no machine credential.</p>
      ) : (
        <div className="scroll">
          <table aria-label="Machine credentials">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scope</th>
                <th scope="col">State</th>
                <th scope="col">Issued</th>
                <th scope="col">Issued by</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.credentialId}>
                  <th scope="row">{row.name}</th>
                  <td>{scope}</td>
                  <td>
                    <StateBadge kind="credential" state={row.state} />
                    <RowNote row={row} />
                  </td>
                  <td>{row.issuedAt === null ? NOT_KNOWN : <Time at={row.issuedAt} />}</td>
                  <td>
                    user <code>{row.issuedBy}</code>
                    {row.issuedBy === userId ? " (you)" : ""}
                  </td>
                  <td>{row.expiresAt === null ? NOT_KNOWN : <Time at={row.expiresAt} />}</td>
                  <td>{row.lastUsedAt === null ? NOT_KNOWN : <Time at={row.lastUsedAt} />}</td>
                  <td>
                    {row.state === "active" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setNotice(null);
                          setRevoking(row);
                        }}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <div className="actions">
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            More
          </button>
        </div>
      ) : null}

      {revoking === null ? null : (
        <RevokeDialog
          at={at}
          credential={revoking}
          onDone={() => {
            setNotice(`${revoking.name} is revoked. Its token is refused from now on.`);
            setRevoking(null);
            refresh();
          }}
          onCancel={() => {
            setRevoking(null);
            // A revocation without an answer may have happened: the list says.
            refresh();
          }}
        />
      )}
    </>
  );
}

export function Credentials() {
  const { organization, project, environment, userId } = useScope();
  if (organization === null || project === null || environment === null) return null;
  const at: At = { org: organization.id, project: project.id, env: environment.id };
  return (
    <>
      <h1>Machine credentials</h1>
      <p className="hint">
        {project.name} / {environment.name}
      </p>
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      <Inventory
        at={at}
        userId={userId}
        scope={`${project.name} / ${environment.name}`}
        writable={environment.state === "active"}
      />
      <section>
        <h2>Replacing a token</h2>
        <p>
          A token cannot be renewed and cannot be shown again. To replace one, issue a new
          credential, move the consumer to the new token, then revoke the old credential.
        </p>
        <p>
          When the service is restored from a backup, every token is revoked, and each consumer
          needs a new credential.
        </p>
        <p>
          &quot;Last used&quot; is the last time the service saw the token, to the minute. &quot;Not
          known&quot; means the service has no record of a use, not that there was none.
        </p>
        <p className="hint">
          The rules for a token and its consumer: <code>{RUNBOOK}</code>.
        </p>
      </section>
    </>
  );
}
