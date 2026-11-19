// The organization's overview (FR-1.90, P-139): its projects, their
// environments and what the secret index counts for each. Every number
// names its source and its time; a count the server did not make is "not
// available", never 0. The route is for owners and admins: a member gets the
// list of the projects they can see, without counts. The role only spares a
// request the server would refuse; the server decides.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CREDENTIAL_STATES, LIMITS, webPath, type OverviewBody } from "@mykey/contracts";
import { useState } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { Link } from "../router.tsx";
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
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Counted(props: { org: string; userId: string }) {
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
      {projects.length === 0 ? <p>This organization has no project yet.</p> : null}
      {projects.map((project) => (
        <section key={project.id} aria-labelledby={`project-${project.id}`}>
          <h2 id={`project-${project.id}`}>
            <Link to={webPath("project", { org, project: project.id })}>{project.name}</Link>{" "}
            <StateBadge kind="resource" state={project.state} />
          </h2>
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
            Counted from the catalog of this organization, as of{" "}
            <Time at={summary.data.observedAt} />. A credential past its expiry counts as expired.
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

function Listed(props: { org: string }) {
  const { projects } = useScope();
  return (
    <>
      <p className="hint">Key counts are shown to owners and admins of the organization.</p>
      {projects === null || projects.items.length === 0 ? (
        <p>There is no project you can see.</p>
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

function NewProject(props: { org: string; userId: string }) {
  const { org, userId } = props;
  const client = useQueryClient();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async (name: string): Promise<void> => {
    const result = await action.run(`projects.create ${org} ${name}`, (key) =>
      call("projects.create", { params: { org }, body: { name }, idempotencyKey: key }),
    );
    if (!result.ok) return;
    setOpen(false);
    setNotice(
      `The project ${name} is created. The server is preparing its first environment (development): both are pending until the server says active.`,
    );
    await client.invalidateQueries({ queryKey: [userId, org] });
  };

  return (
    <>
      {open ? (
        <NameForm
          label="Project name"
          submit="Create project"
          rule={PROJECT_NAME_RULE}
          problem={projectNameProblem}
          within="this organization"
          busy={action.busy}
          failure={action.failure}
          action="create the project"
          onSubmit={(name) => void create(name)}
          onCancel={() => {
            setOpen(false);
            action.clear();
          }}
        />
      ) : (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setOpen(true);
            }}
          >
            New project
          </button>
        </div>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
    </>
  );
}

export function Overview() {
  const { organization, userId } = useScope();
  if (organization === null) return null;
  const manages = organization.role === "owner" || organization.role === "admin";
  return (
    <>
      <h1>Overview</h1>
      {manages ? (
        <>
          <NewProject org={organization.id} userId={userId} />
          <Counted org={organization.id} userId={userId} />
        </>
      ) : (
        <Listed org={organization.id} />
      )}
    </>
  );
}
