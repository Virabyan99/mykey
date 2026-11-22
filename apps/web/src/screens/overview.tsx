// The organization's overview (FR-1.90, P-139): its projects, their
// environments and what the secret index counts for each. Every number
// names its source and its time; a count the server did not make is "not
// available", never 0. The route is for owners and admins: a member gets the
// list of the projects they can see, without counts. The role only spares a
// request the server would refuse; the server decides.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CREDENTIAL_STATES,
  LIMITS,
  webPath,
  type MetricsBody,
  type OverviewBody,
} from "@mykey/contracts";
import { useEffect, useState } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { PAGES } from "../copy/pages.ts";
import { Link } from "../router.tsx";
import { onIntent, take } from "../state/intent.ts";
import { useScope } from "../state/scope.tsx";
import { useAction } from "../state/use-action.ts";
import { isMoving, useFollow } from "../state/use-follow.ts";
import {
  FollowNote,
  NameForm,
  PROJECT_NAME_RULE,
  ReviewNote,
  projectNameProblem,
} from "../ui/Resource.tsx";
import { EnvironmentLinks } from "../ui/EnvironmentLinks.tsx";
import { IdChip, IdLine } from "../ui/IdChip.tsx";
import { Icon } from "../ui/icons.tsx";
import { EmptyState, PageHeader } from "../ui/PageHeader.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { GettingStarted } from "./getting-started.tsx";
import { Time } from "../ui/Time.tsx";

type Project = OverviewBody["projects"][number];
type Environment = Project["environments"][number];

const NOT_AVAILABLE = <span className="muted">not available</span>;

function Environments(props: { org: string; project: Project }) {
  const { org, project } = props;
  if (project.environments.length === 0) return <p className="muted">No environment.</p>;
  const count = (row: Environment, pick: (keys: NonNullable<Environment["keys"]>) => number) =>
    row.keys === null ? NOT_AVAILABLE : pick(row.keys);
  return (
    <div className="scroll">
      <table aria-label={`Environments of ${project.name}`}>
        <thead>
          <tr>
            <th scope="col">Environment</th>
            <th scope="col">State</th>
            <th scope="col">Live keys</th>
            <th scope="col">Deleted</th>
            <th scope="col">Under review</th>
            <th scope="col">Last change</th>
            <th scope="col">Open</th>
          </tr>
        </thead>
        <tbody>
          {project.environments.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <Link to={webPath("secrets", { org, project: project.id, env: row.id })}>
                  {row.name}
                </Link>
              </th>
              <td>
                <StateBadge kind="resource" state={row.state} />
                <ReviewNote state={row.state} reason={row.reviewReason} />
              </td>
              <td>{count(row, (keys) => keys.live)}</td>
              <td>{count(row, (keys) => keys.deleted)}</td>
              <td>{count(row, (keys) => keys.needsReview)}</td>
              <td>
                {row.keys === null ? NOT_AVAILABLE : <Time at={row.changedAt} none="none yet" />}
              </td>
              <td>
                <EnvironmentLinks org={org} project={project.id} env={row.id} name={row.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Counted(props: { org: string; userId: string; onFirst?: () => void }) {
  const { org, userId } = props;
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: [userId, org, "overview"],
    queryFn: () => need(call("overview.get", { params: { org } })),
  });
  const waiting =
    overview.data?.projects.some(
      (project) =>
        isMoving(project.state) || project.environments.some((row) => isMoving(row.state)),
    ) ?? false;
  const follow = useFollow(waiting, () => {
    void client.invalidateQueries({ queryKey: [userId, org] });
  });

  if (overview.isPending) return <Loading what="the overview" />;
  if (overview.isError) {
    return (
      <ErrorPanel
        failure={failureOf(overview.error)}
        action="read the overview"
        onReload={() => void overview.refetch()}
      />
    );
  }
  const { projects, observedAt, truncated } = overview.data;
  return (
    <>
      <p className="hint">
        Key counts come from the index, as of <Time at={observedAt} />. They are counts of names: no
        value is read for this page.
      </p>
      <FollowNote waiting={waiting} follow={follow} />
      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          text="A project holds the environments and secrets of one application. Create one to begin."
          learn="getting-started"
          {...(props.onFirst === undefined
            ? {}
            : {
                action: (
                  <button type="button" className="primary" onClick={props.onFirst}>
                    Create your first project
                  </button>
                ),
              })}
        />
      ) : null}
      {projects.map((project) => (
        <section key={project.id} aria-labelledby={`project-${project.id}`}>
          <h2 id={`project-${project.id}`}>
            <Link to={webPath("project", { org, project: project.id })}>{project.name}</Link>{" "}
            <StateBadge kind="resource" state={project.state} />
          </h2>
          <p className="page-ids">
            <IdChip of={`${project.name} project`} id={project.id} />
          </p>
          <ReviewNote state={project.state} reason={project.reviewReason} />
          <Environments org={org} project={project} />
        </section>
      ))}
      {truncated ? (
        <p role="status">
          Only the first {projects.length} projects are shown. The scope bar lists the others.
        </p>
      ) : null}
      <CredentialSummary org={org} userId={userId} projects={projects} />
    </>
  );
}

const WARNING_DAYS = Math.floor(LIMITS.machineToken.expiryWarningSeconds / 86_400);

/** The organization's machine credentials in numbers (FR-1.91): the catalog's, at one time. */
function CredentialSummary(props: { org: string; userId: string; projects: readonly Project[] }) {
  const { org, userId, projects } = props;
  const summary = useQuery({
    queryKey: [userId, org, "credentials-summary"],
    queryFn: () => need(call("credentials.summary", { params: { org } })),
  });
  const placeOf = (projectId: string, environmentId: string): string => {
    const project = projects.find((candidate) => candidate.id === projectId);
    const environment = project?.environments.find((candidate) => candidate.id === environmentId);
    return project === undefined || environment === undefined
      ? "an environment not shown above"
      : `${project.name} / ${environment.name}`;
  };
  return (
    <section aria-labelledby="credentials-summary">
      <h2 id="credentials-summary">Machine credentials</h2>
      {summary.isPending ? <Loading what="the credentials summary" /> : null}
      {summary.isError ? (
        <ErrorPanel
          failure={failureOf(summary.error)}
          action="read the credentials summary"
          onReload={() => void summary.refetch()}
        />
      ) : null}
      {summary.data === undefined ? null : (
        <>
          <p className="hint">
            Source: the credential catalog of this organization. Window: every credential it lists.
            Observed <Time at={summary.data.observedAt} />. A credential past its expiry counts as
            expired.
          </p>
          <div className="scroll">
            <table aria-label="Credentials by state">
              <thead>
                <tr>
                  <th scope="col">State</th>
                  <th scope="col">Credentials</th>
                </tr>
              </thead>
              <tbody>
                {CREDENTIAL_STATES.map((state) => (
                  <tr key={state}>
                    <th scope="row">
                      <StateBadge kind="credential" state={state} />
                    </th>
                    <td>{summary.data.byState[state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 id="credentials-expiring">Expiring within {WARNING_DAYS} days</h3>
          {summary.data.expiring.length === 0 ? (
            <p>No active credential expires within {WARNING_DAYS} days.</p>
          ) : (
            <ul aria-labelledby="credentials-expiring" className="rows">
              {summary.data.expiring.map((row) => (
                <li key={row.credentialId}>
                  {row.name}, in{" "}
                  <Link
                    to={webPath("credentials", {
                      org,
                      project: row.projectId,
                      env: row.environmentId,
                    })}
                  >
                    {placeOf(row.projectId, row.environmentId)}
                  </Link>
                  , expires <Time at={row.expiresAt} />
                </li>
              ))}
            </ul>
          )}
          {summary.data.expiringTruncated ? (
            <p role="status">
              Only the {summary.data.expiring.length} that expire soonest are listed.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

const OUTCOME_COLUMNS = [
  ["success", "Succeeded"],
  ["failure", "Failed"],
  ["unknown", "Not known"],
  ["denied", "Denied"],
] as const;

const utcDay = (at: string): string => at.slice(0, 10);

/**
 * The summary of FR-1.94 as tables (P-142). Every table names its source, its
 * window and the time it was observed. A day the audit log does not cover is
 * "not measured"; a 0 is a day that was counted and had nothing.
 */
function Summary(props: { org: string; userId: string }) {
  const { org, userId } = props;
  const metrics = useQuery({
    queryKey: [userId, org, "metrics"],
    queryFn: () => need(call("metrics.get", { params: { org }, query: {} })),
  });
  if (metrics.isPending) return <Loading what="the summary" />;
  if (metrics.isError) {
    return (
      <ErrorPanel
        failure={failureOf(metrics.error)}
        action="read the summary"
        onReload={() => void metrics.refetch()}
      />
    );
  }
  const { days, window, observedAt, measuredFrom, operations } = metrics.data;
  const totalOf = (counts: NonNullable<MetricsBody["days"][number]["counts"]>): number =>
    counts.success + counts.failure + counts.unknown + counts.denied;
  const most = Math.max(1, ...days.map((day) => (day.counts === null ? 0 : totalOf(day.counts))));
  return (
    <>
      <section aria-labelledby="summary-outcomes">
        <h2 id="summary-outcomes">Outcomes by day</h2>
        <p className="hint">
          Source: the audit log of this organization. Window: {utcDay(window.from)} to{" "}
          {utcDay(window.to)}, in UTC days; the last day is counted up to the observation. Observed{" "}
          <Time at={observedAt} />.{" "}
          {measuredFrom === null
            ? "Nothing was measured: the audit log has no event of this organization."
            : `Nothing was measured before ${utcDay(measuredFrom)}, the day of the oldest event the audit log holds.`}
        </p>
        <div className="scroll">
          <table aria-label="Outcomes by day">
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                {OUTCOME_COLUMNS.map(([key, title]) => (
                  <th key={key} scope="col">
                    {title}
                  </th>
                ))}
                <th scope="col">All</th>
              </tr>
            </thead>
            <tbody>
              {days.map(({ day, counts }) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {counts === null ? (
                    <td colSpan={OUTCOME_COLUMNS.length + 1} className="muted">
                      not measured
                    </td>
                  ) : (
                    <>
                      {OUTCOME_COLUMNS.map(([key]) => (
                        <td key={key}>{counts[key]}</td>
                      ))}
                      <td>
                        {totalOf(counts)}
                        {/* Decoration: the number is the text before it. */}
                        <meter
                          className="bar"
                          aria-hidden="true"
                          min={0}
                          max={most}
                          value={totalOf(counts)}
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Succeeded, failed and not known count the events of the activity timeline by their
          outcome. Denied counts the requests the service refused for lack of permission.
        </p>
      </section>
      <section aria-labelledby="summary-operations">
        <h2 id="summary-operations">Operations without an end</h2>
        <p className="hint">
          Source: the operations of this organization. Window: every operation the server still
          holds. Observed <Time at={observedAt} />.
        </p>
        <div className="scroll">
          <table aria-label="Operations without an end">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Operations</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Not ended: accepted, executing, waiting for a file, or not known
                </th>
                <td>{operations.unresolved}</td>
              </tr>
              <tr>
                <th scope="row">Outcome not known, settled or not</th>
                <td>{operations.uncertain}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          Each is listed, with its state, under Operations of its environment. An operation whose
          outcome is not known is settled by an operator from the host (runbook reconciliation.md).
        </p>
      </section>
    </>
  );
}

function Listed(props: { org: string }) {
  const { projects } = useScope();
  return (
    <>
      <p className="hint">
        Key counts and the summary are shown to owners and admins of the organization.
      </p>
      {projects === null || projects.items.length === 0 ? (
        <EmptyState
          title="No projects you can see"
          text="An owner or an admin gives you access to a project or an environment."
          learn="projects-environments"
        />
      ) : (
        <ul className="rows">
          {projects.items.map((project) => (
            <li key={project.id}>
              <Link to={webPath("project", { org: props.org, project: project.id })}>
                {project.name}
              </Link>{" "}
              <StateBadge kind="resource" state={project.state} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The new-project form: opened by the page's primary action, by the empty state, or by the sidebar. */
function NewProject(props: {
  org: string;
  userId: string;
  onCreated: (notice: string) => void;
  onClose: () => void;
}) {
  const { org, userId } = props;
  const client = useQueryClient();
  const action = useAction();

  const create = async (name: string): Promise<void> => {
    const result = await action.run(`projects.create ${org} ${name}`, (key) =>
      call("projects.create", { params: { org }, body: { name }, idempotencyKey: key }),
    );
    if (!result.ok) return;
    props.onCreated(
      `The project ${name} is created. The server is preparing its first environment (development): both are pending until the server says active.`,
    );
    await client.invalidateQueries({ queryKey: [userId, org] });
  };

  return (
    <NameForm
      label="Project name"
      submit="Create project"
      rule={PROJECT_NAME_RULE}
      problem={projectNameProblem}
      within="this organization"
      busy={action.busy || action.held}
      failure={action.failure}
      action="create the project"
      onSubmit={(name) => void create(name)}
      onCancel={() => {
        action.clear();
        props.onClose();
      }}
    />
  );
}

export function Overview() {
  const { organization, userId } = useScope();
  const [creating, setCreating] = useState(() => take("new-project"));
  const [notice, setNotice] = useState<string | null>(null);
  // The sidebar's "New project" while this page is already open.
  useEffect(
    () =>
      onIntent(() => {
        if (take("new-project")) setCreating(true);
      }),
    [],
  );
  if (organization === null) return null;
  const manages = organization.role === "owner" || organization.role === "admin";
  const open = (): void => {
    setNotice(null);
    setCreating(true);
  };
  return (
    <>
      <PageHeader
        page={PAGES.overview}
        meta={<IdLine of="organization" id={organization.id} />}
        actions={
          manages && !creating ? (
            <button type="button" className="primary" onClick={open}>
              <Icon name="plus" />
              New project
            </button>
          ) : undefined
        }
      />
      {manages && creating ? (
        <NewProject
          org={organization.id}
          userId={userId}
          onCreated={(text) => {
            setCreating(false);
            setNotice(text);
          }}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      {notice === null ? null : <p role="status">{notice}</p>}
      {manages ? (
        <>
          <GettingStarted org={organization.id} userId={userId} />
          <Counted org={organization.id} userId={userId} {...(creating ? {} : { onFirst: open })} />
          <Summary org={organization.id} userId={userId} />
        </>
      ) : (
        <Listed org={organization.id} />
      )}
    </>
  );
}
