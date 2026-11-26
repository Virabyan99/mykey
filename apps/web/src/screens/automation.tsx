// The automation credentials of one organization (Session 11, Run 11.6;
// D-82): what a provisioning script holds. The inventory is what the server
// lists: rights, networks, expiry, last use, and how many projects the
// credential's chain manages. The secret exists in the page exactly once, in
// the answer that made it, held by the forgetting holder and gone when its
// time ends, when the tab is hidden, on navigation and on sign-out; the page
// then says it cannot be shown again. The page checks how many networks were
// named and nothing else about them: the service's answer decides.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  AUTOMATION_RIGHTS,
  LIMITS,
  checkProjectName,
  type AutomationCredentialView,
  type AutomationRight,
} from "@mykey/contracts";
import { useId, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ACTIONS } from "../copy/actions.ts";
import { CREDENTIAL_COPY } from "../copy/credentials.ts";
import { PAGES } from "../copy/pages.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { AreaField, Field } from "../ui/Field.tsx";
import { Icon } from "../ui/icons.tsx";
import { Callout, EmptyState, PageHeader } from "../ui/PageHeader.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { StepUp } from "../ui/StepUp.tsx";
import { Time } from "../ui/Time.tsx";
import {
  DAY_SECONDS,
  NETWORKS_HINT,
  NETWORK_REFUSED,
  ONCE_TTL_MS,
  OncePanel,
  daysOf,
  networksOf,
  type Once,
} from "./credential-parts.tsx";

const MAX_DAYS = Math.floor(LIMITS.automationCredential.maxTtlSeconds / DAY_SECONDS);
const DEFAULT_DAYS = Math.floor(LIMITS.automationCredential.defaultTtlSeconds / DAY_SECONDS);
const MAX_NETWORKS = LIMITS.automationCredential.maxCidrs;
const WARNING_DAYS = Math.floor(LIMITS.machineToken.expiryWarningSeconds / DAY_SECONDS);

const NAME_RULE = `A credential name is ${String(LIMITS.project.nameMinCodePoints)} to ${String(LIMITS.project.nameMaxCodePoints)} characters, not only spaces and without control characters.`;
const DAYS_RULE = `A lifetime is a whole number of days from 1 to ${String(MAX_DAYS)}.`;
const RIGHTS_RULE = "Choose at least one right.";
const NETWORKS_RULE = `Name one to ${String(MAX_NETWORKS)} networks, one per line, each once.`;

interface Problems {
  name: string | null;
  rights: string | null;
  days: string | null;
  networks: string | null;
}
const NO_PROBLEMS: Problems = { name: null, rights: null, days: null, networks: null };

function IssueForm(props: {
  org: string;
  /** Every credential the list has read: one of them may be replaced. */
  existing: readonly AutomationCredentialView[];
  /** The secret of the answer, or null when it arrived while the tab was hidden. */
  onIssued: (name: string, secret: string | null) => void;
  /** Any answer or none: the list may have a new row. */
  onAnswer: () => void;
  onCancel: () => void;
}) {
  const action = useAction();
  const group = useId();
  const choice = useId();
  const [name, setName] = useState("");
  const [rights, setRights] = useState<ReadonlySet<AutomationRight>>(new Set());
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [networks, setNetworks] = useState("");
  const [replaces, setReplaces] = useState("");
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setNote(null);
    const wanted = name.trim().normalize("NFC");
    const lifetime = daysOf(days, MAX_DAYS);
    const cidrs = networksOf(networks);
    const chosen = AUTOMATION_RIGHTS.filter((right) => rights.has(right));
    const found: Problems = {
      name: checkProjectName(wanted).ok ? null : NAME_RULE,
      rights: chosen.length > 0 ? null : RIGHTS_RULE,
      days: lifetime === null ? DAYS_RULE : null,
      networks:
        cidrs.length >= 1 && cidrs.length <= MAX_NETWORKS && new Set(cidrs).size === cidrs.length
          ? null
          : NETWORKS_RULE,
    };
    setProblems(found);
    if (lifetime === null || Object.values(found).some((problem) => problem !== null)) return;
    const result = await action.run(
      `automation_credentials.issue ${wanted} ${chosen.join(",")} ${String(lifetime)} ${cidrs.join(",")} ${replaces}`,
      (key) =>
        callSecret("automation_credentials.issue", {
          params: { org: props.org },
          body: {
            name: wanted,
            rights: chosen,
            ttlSeconds: lifetime * DAY_SECONDS,
            cidrs,
            ...(replaces === "" ? {} : { replaces }),
          },
          idempotencyKey: key,
        }),
    );
    props.onAnswer();
    if (result.ok) {
      // A secret that arrived while nobody could see the tab is not kept.
      props.onIssued(wanted, document.visibilityState === "hidden" ? null : result.body.secret);
      return;
    }
    // The code is older than ten minutes: the owner proves presence, then asks again.
    if (isCode(result.failure, "fresh_verification_required")) {
      action.clear();
      setAsking(true);
      return;
    }
    // The page did not check the networks: the service did.
    if (isCode(result.failure, "validation_failed")) {
      setProblems({ ...found, networks: NETWORK_REFUSED });
    }
  };

  return (
    <>
      <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
        <h2>New automation credential</h2>
        <p>
          {CREDENTIAL_COPY.automation.intro} {ACTIONS.issueAutomation} Issuing needs a code from
          your authenticator of the last ten minutes.
        </p>
        <Field
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={problems.name}
          hint="Say which script holds it, e.g. the platform's provisioner."
          autoComplete="off"
        />
        <fieldset aria-describedby={problems.rights === null ? undefined : `${group}-error`}>
          <legend>Rights</legend>
          {AUTOMATION_RIGHTS.map((right) => {
            const id = `${group}-${right}`;
            const words = CREDENTIAL_COPY.rights[right];
            return (
              <div className="field" key={right}>
                <label htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={rights.has(right)}
                    aria-describedby={`${id}-hint`}
                    onChange={(event) => {
                      const next = new Set(rights);
                      if (event.target.checked) next.add(right);
                      else next.delete(right);
                      setRights(next);
                    }}
                  />{" "}
                  {words.label}
                </label>
                <p className="hint" id={`${id}-hint`}>
                  {words.text}
                </p>
              </div>
            );
          })}
          {problems.rights === null ? null : (
            <p className="field-error" id={`${group}-error`} role="alert">
              {problems.rights}
            </p>
          )}
        </fieldset>
        <Field
          label="Lifetime in days"
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
          }}
          inputMode="numeric"
          error={problems.days}
          hint={`From 1 to ${String(MAX_DAYS)}; ${String(DEFAULT_DAYS)} unless you say otherwise. It cannot be renewed: before it ends, a credential that replaces it takes over.`}
          autoComplete="off"
        />
        <AreaField
          label="Networks it may call from"
          value={networks}
          onChange={(event) => {
            setNetworks(event.target.value);
          }}
          error={problems.networks}
          hint={`${NETWORKS_HINT} At least one, at most ${String(MAX_NETWORKS)}: a request from anywhere else is refused.`}
        />
        <div className="field">
          <label htmlFor={choice}>Replaces</label>
          <select
            id={choice}
            value={replaces}
            aria-describedby={`${choice}-hint`}
            onChange={(event) => {
              setReplaces(event.target.value);
            }}
          >
            <option value="">{CREDENTIAL_COPY.automation.alone}</option>
            {props.existing.map((row) => (
              <option key={row.credentialId} value={row.credentialId}>
                {row.name} ({row.state}, {row.managedProjects}{" "}
                {row.managedProjects === 1 ? "project" : "projects"})
              </option>
            ))}
          </select>
          <p className="hint" id={`${choice}-hint`}>
            {CREDENTIAL_COPY.automation.replaces}
          </p>
        </div>
        {note === null ? null : <p role="status">{note}</p>}
        {action.failure === null ? null : (
          <ErrorPanel failure={action.failure} action="issue the automation credential" />
        )}
        <div className="actions">
          <button type="submit" disabled={action.busy || action.held}>
            Issue automation credential
          </button>
          <button type="button" onClick={props.onCancel} disabled={action.busy}>
            Cancel
          </button>
        </div>
      </form>
      {/* A form of its own: inside the form above, its submit would also be this one's. */}
      <StepUp
        open={asking}
        action="issue an automation credential"
        onDone={(confirmed) => {
          setAsking(false);
          if (confirmed) setNote("Confirmed. Issue the credential again.");
        }}
      />
    </>
  );
}

function RevokeDialog(props: {
  org: string;
  credential: AutomationCredentialView;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { credential } = props;
  const action = useAction();
  const revoke = async (): Promise<void> => {
    const result = await action.run(
      `automation_credentials.revoke ${credential.credentialId}`,
      (key) =>
        call("automation_credentials.revoke", {
          params: { org: props.org, credential: credential.credentialId },
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
      {ACTIONS.revokeAutomation.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action="revoke the automation credential" />
      )}
    </ConfirmDialog>
  );
}

function Inventory(props: { org: string; userId: string }) {
  const { org, userId } = props;
  const client = useQueryClient();
  const [shown, show, hide] = useEphemeral<Once>(ONCE_TTL_MS);
  /** The credential whose secret this page showed last, while the page still speaks of it. */
  const [carried, setCarried] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  const [revoking, setRevoking] = useState<AutomationCredentialView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queryKey = [userId, org, "automation-credentials"];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      need(
        call("automation_credentials.list", {
          params: { org },
          query: { limit: LIMITS.listing.defaultLimit, cursor: pageParam },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: [userId, org] });
  };
  const open = (): void => {
    setNotice(null);
    setCarried(null);
    hide();
    setForm(true);
  };

  const rows = list.data?.pages.flatMap((page) => page.credentials) ?? [];
  const nameOf = (id: string): string | null =>
    rows.find((row) => row.credentialId === id)?.name ?? null;

  return (
    <>
      {shown === null ? null : (
        <OncePanel
          title="The secret, shown once"
          label="Secret"
          copy="Copy secret"
          shown={shown}
          onHide={hide}
        >
          <p>
            This is the secret of {shown.name}. {CREDENTIAL_COPY.automation.once}
          </p>
        </OncePanel>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
      {shown === null && carried !== null ? (
        <p role="status">{CREDENTIAL_COPY.automation.gone}</p>
      ) : null}
      {list.data === undefined ? null : form ? (
        <IssueForm
          org={org}
          existing={rows}
          onAnswer={refresh}
          onIssued={(name, secret) => {
            setForm(false);
            if (secret === null) {
              setNotice(
                `${name} was issued, and its secret arrived while this tab was hidden, so it was not kept. It cannot be shown again: revoke ${name} and issue a credential that replaces it.`,
              );
              return;
            }
            setNotice(`${name} is issued.`);
            setCarried(name);
            show({ secret, name, until: Date.now() + ONCE_TTL_MS });
          }}
          onCancel={() => {
            setForm(false);
          }}
        />
      ) : (
        <div className="actions">
          <button type="button" className="primary" onClick={open}>
            <Icon name="plus" />
            New automation credential
          </button>
        </div>
      )}

      {list.isPending ? <Loading what="the automation credentials" /> : null}
      {list.isError ? (
        <ErrorPanel
          failure={failureOf(list.error)}
          action="read the automation credentials"
          onReload={() => void list.refetch()}
        />
      ) : null}
      {list.data === undefined ? null : rows.length === 0 ? (
        <EmptyState
          title="No automation credentials yet"
          text="An automation credential lets a script create projects, their secrets and the runtime credentials of their servers."
          learn="automation"
        />
      ) : (
        <div className="scroll">
          <table aria-label="Automation credentials">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">Rights</th>
                <th scope="col">Networks</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">Managed projects</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const first = row.ownerId === row.credentialId ? null : nameOf(row.ownerId);
                return (
                  <tr key={row.credentialId}>
                    <th scope="row">{row.name}</th>
                    <td>
                      <StateBadge kind="credential" state={row.state} />
                      {row.state === "active" && row.expiringSoon ? (
                        <p className="review">
                          Expires within {WARNING_DAYS} days. Issue a credential that replaces it,
                          move the script to the new secret, then revoke this one.
                        </p>
                      ) : null}
                      {row.ownerId === row.credentialId ? null : (
                        <p className="hint">
                          Continues the chain of {first ?? <code>{row.ownerId}</code>}.
                        </p>
                      )}
                    </td>
                    <td>
                      <ul>
                        {row.rights.map((right) => (
                          <li key={right}>{CREDENTIAL_COPY.rights[right].label}</li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      {row.boundCidrs.map((network) => (
                        <div key={network}>
                          <code>{network}</code>
                        </div>
                      ))}
                    </td>
                    <td>
                      <Time at={row.expiresAt} />
                    </td>
                    <td>
                      <Time at={row.lastUsedAt} />
                    </td>
                    <td>{row.managedProjects}</td>
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
                );
              })}
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
          org={org}
          credential={revoking}
          onDone={() => {
            setNotice(`${revoking.name} is revoked. Its secret is refused from now on.`);
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

export function Automation() {
  const { organization, userId } = useScope();
  if (organization === null) return null;
  return (
    <>
      <PageHeader page={PAGES.automation} />
      <Inventory org={organization.id} userId={userId} />
      <Callout title="What an automation credential reaches">
        <p>
          Only the projects its chain created. Every other project of this organization answers it
          as if it did not exist, whatever its rights.
        </p>
        <p>&quot;Last used&quot; is the last time the service saw the credential, to the minute.</p>
      </Callout>
    </>
  );
}
