// Machine credentials of one environment (FR-1.41 to FR-1.44, P-138). The
// inventory is what the server's catalog says, and "not known" where it says
// nothing. A token exists in the page exactly once: in the answer that made
// it, held by the forgetting holder for 120 seconds and gone when the owner
// hides the tab, leaves the screen or signs out. It cannot be shown again,
// and the page says so before and after. A row whose outcome is open is
// settled by an operator: the page offers nothing on it.
//
// Session 11 (Run 11.6, D-81): the form opens with a choice of two kinds. A
// runtime credential's client secret is shown once in the same way, and the
// list says which kind a row is, who issued it and where it may call from.
import { ACTIONS } from "../copy/actions.ts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, checkProjectName, webPath, type CredentialView } from "@mykey/contracts";
import { useId, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { CREDENTIAL_COPY } from "../copy/credentials.ts";
import { PAGES } from "../copy/pages.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { AreaField, Field } from "../ui/Field.tsx";
import { Icon } from "../ui/icons.tsx";
import { Callout, EmptyState, PageHeader, ScopeIds } from "../ui/PageHeader.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { CopyButton, SecretLine } from "../ui/Secret.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { StepUp } from "../ui/StepUp.tsx";
import { Time } from "../ui/Time.tsx";
import {
  NETWORKS_HINT,
  NETWORK_REFUSED,
  OncePanel,
  daysOf,
  networksOf,
} from "./credential-parts.tsx";
import { useNow, type At } from "./secret-value.tsx";

/** A token stays on the screen longer than a value: it has to be carried to its consumer. */
const TOKEN_TTL_MS = 120_000;
const DAY_SECONDS = 86_400;
const MAX_DAYS = Math.floor(LIMITS.machineToken.maxTtlSeconds / DAY_SECONDS);
const WARNING_DAYS = Math.floor(LIMITS.machineToken.expiryWarningSeconds / DAY_SECONDS);
const RUNTIME_MAX_DAYS = Math.floor(LIMITS.runtimeCredential.maxTtlSeconds / DAY_SECONDS);
const MAX_NETWORKS = LIMITS.runtimeCredential.maxCidrs;
const RUNBOOK = "docs/runbooks/machine-credentials.md";

const NAME_RULE = `A credential name is ${String(LIMITS.project.nameMinCodePoints)} to ${String(LIMITS.project.nameMaxCodePoints)} characters, not only spaces and without control characters.`;

interface Shown {
  /** Which kind the secret is of: a 30-day token, or a runtime credential's client secret. */
  kind: "token" | "runtime";
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

type Kind = "token" | "runtime";
const KIND_MAX_DAYS: Readonly<Record<Kind, number>> = {
  token: MAX_DAYS,
  runtime: RUNTIME_MAX_DAYS,
};
const daysRule = (max: number): string =>
  `A lifetime is a whole number of days from 1 to ${String(max)}.`;
const NETWORKS_RULE = `Name at most ${String(MAX_NETWORKS)} networks, one per line, each once.`;

function IssueForm(props: {
  at: At;
  /** The token or the client secret of the answer, or null when it arrived while the tab was hidden. */
  onIssued: (name: string, kind: Kind, secret: string | null) => void;
  /** Any answer or none: the catalog may have a new row. */
  onAnswer: () => void;
  onCancel: () => void;
  /** Why nothing can be issued now, or null. The last answer of the form stays readable. */
  blocked: string | null;
}) {
  const { at, blocked } = props;
  const action = useAction();
  const group = useId();
  const [kind, setKind] = useState<Kind>("token");
  const [name, setName] = useState("");
  const [days, setDays] = useState(String(MAX_DAYS));
  const [networks, setNetworks] = useState("");
  const [problems, setProblems] = useState<{
    name: string | null;
    days: string | null;
    networks: string | null;
  }>({ name: null, days: null, networks: null });
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /** Each kind opens with its own longest lifetime, which is also its default. */
  const choose = (next: Kind): void => {
    setKind(next);
    setDays(String(KIND_MAX_DAYS[next]));
    setProblems({ name: null, days: null, networks: null });
    action.clear();
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setNote(null);
    const wanted = name.trim().normalize("NFC");
    const lifetime = daysOf(days, KIND_MAX_DAYS[kind]);
    const cidrs = kind === "runtime" ? networksOf(networks) : [];
    const found = {
      name: checkProjectName(wanted).ok ? null : NAME_RULE,
      days: lifetime === null ? daysRule(KIND_MAX_DAYS[kind]) : null,
      networks:
        cidrs.length <= MAX_NETWORKS && new Set(cidrs).size === cidrs.length ? null : NETWORKS_RULE,
    };
    setProblems(found);
    if (lifetime === null || found.name !== null || found.networks !== null) return;
    if (blocked !== null) return;
    const result =
      kind === "token"
        ? await action.run(`credentials.issue ${at.env} ${wanted} ${String(lifetime)}`, (key) =>
            callSecret("credentials.issue", {
              params: at,
              body: { name: wanted, ttlSeconds: lifetime * DAY_SECONDS },
              idempotencyKey: key,
            }),
          )
        : await action.run(
            `runtime_credentials.issue ${at.env} ${wanted} ${String(lifetime)} ${cidrs.join(",")}`,
            (key) =>
              callSecret("runtime_credentials.issue", {
                params: at,
                body: { name: wanted, ttlSeconds: lifetime * DAY_SECONDS, cidrs },
                idempotencyKey: key,
              }),
          );
    props.onAnswer();
    if (result.ok) {
      const secret = "token" in result.body ? result.body.token : result.body.clientSecret;
      // A secret that arrived while nobody could see the tab is not kept.
      props.onIssued(wanted, kind, document.visibilityState === "hidden" ? null : secret);
      return;
    }
    // The code is older than ten minutes: the owner proves presence, then asks again.
    if (isCode(result.failure, "fresh_verification_required")) {
      action.clear();
      setAsking(true);
      return;
    }
    // The page did not check the networks: the service did.
    if (kind === "runtime" && isCode(result.failure, "validation_failed")) {
      setProblems({ ...found, networks: NETWORK_REFUSED });
    }
  };

  return (
    <>
      <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
        <h2>New credential</h2>
        <p>
          A credential lets one consumer read the complete secret set of this environment, and
          nothing else.{" "}
          {kind === "token"
            ? ACTIONS.issue
            : `${CREDENTIAL_COPY.runtime.how} ${ACTIONS.issueRuntime}`}{" "}
          Issuing needs a code from your authenticator of the last ten minutes.
        </p>
        {blocked === null ? null : <p role="status">{blocked}</p>}
        <fieldset>
          <legend>Kind</legend>
          {(["token", "runtime"] as const).map((option) => {
            const id = `${group}-${option}`;
            const words = CREDENTIAL_COPY.kinds[option];
            return (
              <div className="field" key={option}>
                <label htmlFor={id}>
                  <input
                    id={id}
                    type="radio"
                    name={group}
                    checked={kind === option}
                    disabled={blocked !== null}
                    onChange={() => {
                      choose(option);
                    }}
                  />{" "}
                  {words.label}: {words.text.charAt(0).toLowerCase()}
                  {words.text.slice(1)}
                </label>
              </div>
            );
          })}
        </fieldset>
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
          hint={
            kind === "token"
              ? `At most ${String(MAX_DAYS)}, which is also the default. A token cannot be renewed: before it ends, a new credential replaces it.`
              : `At most ${String(RUNTIME_MAX_DAYS)}, which is also the default. It cannot be renewed: before it ends, a new credential replaces it.`
          }
          autoComplete="off"
        />
        {kind === "runtime" ? (
          <AreaField
            label="Networks it may call from (optional)"
            disabled={blocked !== null}
            value={networks}
            onChange={(event) => {
              setNetworks(event.target.value);
            }}
            error={problems.networks}
            hint={`${NETWORKS_HINT} At most ${String(MAX_NETWORKS)}. With none, the client secret works from any network.`}
          />
        ) : null}
        {note === null ? null : <p role="status">{note}</p>}
        {action.failure === null ? null : (
          <ErrorPanel failure={action.failure} action="issue the credential" />
        )}
        <div className="actions">
          {blocked === null ? (
            <button type="submit" disabled={action.busy || action.held}>
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
      busy={action.busy || action.held}
      onConfirm={() => void revoke()}
      onCancel={props.onCancel}
    >
      {(credential.kind === "runtime" ? ACTIONS.revokeRuntime : ACTIONS.revoke).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action="revoke the credential" />
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
      {shown === null ? null : shown.kind === "token" ? (
        <TokenPanel shown={shown} onHide={hide} />
      ) : (
        <OncePanel
          title="The client secret, shown once"
          label="Client secret"
          copy="Copy client secret"
          shown={{ secret: shown.token, name: shown.name, until: shown.until }}
          onHide={hide}
        >
          <p>
            This is the client secret of {shown.name}. {CREDENTIAL_COPY.runtime.once}
          </p>
        </OncePanel>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
      {!writable || list.data === undefined ? null : form ? (
        <IssueForm
          at={at}
          blocked={blocked}
          onAnswer={refresh}
          onIssued={(name, kind, token) => {
            setForm(false);
            if (token === null) {
              setNotice(
                `${name} was issued, and its ${kind === "token" ? "token" : "client secret"} arrived while this tab was hidden, so it was not kept. It cannot be shown again: revoke ${name} and issue a new credential.`,
              );
              return;
            }
            setNotice(`${name} is issued.`);
            show({ kind, token, name, until: Date.now() + TOKEN_TTL_MS });
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
            className="primary"
            onClick={() => {
              setNotice(null);
              hide();
              setForm(true);
            }}
          >
            <Icon name="plus" />
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
        <EmptyState
          title="No machine credentials yet"
          text="A machine credential lets the machine that runs your application read this environment's secrets."
          learn="machine-credentials"
          {...(writable && blocked === null && !form
            ? {
                action: (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      setNotice(null);
                      hide();
                      setForm(true);
                    }}
                  >
                    Issue the first credential
                  </button>
                ),
              }
            : {})}
        />
      ) : (
        <div className="scroll">
          <table aria-label="Machine credentials">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
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
                  <td>
                    {CREDENTIAL_COPY.kinds[row.kind].word}
                    {row.kind === "runtime" ? (
                      <p className="hint">
                        {row.boundCidrs.length === 0
                          ? CREDENTIAL_COPY.runtime.anywhere
                          : `from ${row.boundCidrs.join(", ")}`}
                      </p>
                    ) : null}
                  </td>
                  <td>{scope}</td>
                  <td>
                    <StateBadge kind="credential" state={row.state} />
                    <RowNote row={row} />
                  </td>
                  <td>{row.issuedAt === null ? NOT_KNOWN : <Time at={row.issuedAt} />}</td>
                  <td>
                    {row.issuedByKind === "automation" ? "automation" : "user"}{" "}
                    <code>{row.issuedBy}</code>
                    {row.issuedByKind === "user" && row.issuedBy === userId ? " (you)" : ""}
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
            setNotice(
              `${revoking.name} is revoked. Its ${revoking.kind === "runtime" ? "client secret" : "token"} is refused from now on.`,
            );
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
      <PageHeader
        page={PAGES.credentials}
        meta={<ScopeIds project={project} environment={environment} />}
      />
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      <Inventory
        at={at}
        userId={userId}
        scope={`${project.name} / ${environment.name}`}
        writable={environment.state === "active"}
      />
      <Callout title="Replacing a token">
        <p>
          A token cannot be renewed and cannot be shown again. To replace one, issue a new
          credential, move the consumer to the new token, then revoke the old credential.
        </p>
        <p>
          When the service is restored from a backup, every token is revoked, and each consumer
          needs a new credential.
        </p>
        <p>
          {CREDENTIAL_COPY.runtime.how} A runtime credential is replaced the same way as a token.
        </p>
        <p>
          <Link to={webPath("connect", at)}>Connect an application</Link> shows the commands that
          store a token and start the application with it.
        </p>
      </Callout>
      <section>
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
