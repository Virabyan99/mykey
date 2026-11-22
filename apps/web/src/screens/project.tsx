// One project and its environments (FR-1.13 to FR-1.17): create, rename,
// archive and reactivate. Every row shows the state the server gave, with
// the reason of a review, and offers only what that state allows. The
// buttons are a convenience for owners and admins: the server decides who
// may do what, and a refusal is shown as it is.
import { useQueryClient } from "@tanstack/react-query";
import { webPath } from "@mykey/contracts";
import { useState } from "react";
import { call } from "../api/client.ts";
import { PAGES } from "../copy/pages.ts";
import { Link } from "../router.tsx";
import { useScope, type Environment } from "../state/scope.tsx";
import { useAction } from "../state/use-action.ts";
import { isMoving, useFollow } from "../state/use-follow.ts";
import {
  ENVIRONMENT_NAME_RULE,
  FollowNote,
  NameForm,
  PROJECT_NAME_RULE,
  ReviewNote,
  environmentNameProblem,
  projectNameProblem,
} from "../ui/Resource.tsx";
import { EnvironmentLinks } from "../ui/EnvironmentLinks.tsx";
import { Icon } from "../ui/icons.tsx";
import { EmptyState, PageHeader, ScopeIds } from "../ui/PageHeader.tsx";
import { StateBadge } from "../ui/StateBadge.tsx";
import { ArchiveDialog, ReactivateDialog, type Target } from "./lifecycle.tsx";

type Open =
  | { kind: "rename-project" }
  | { kind: "new-environment" }
  | { kind: "rename-environment"; id: string; name: string }
  | { kind: "archive"; target: Target }
  | { kind: "reactivate"; target: Target }
  | null;

/** A name can be changed, and an environment added, while the server still prepares the resource. */
const nameable = (state: string): boolean => state === "active" || state === "pending";

export function Project() {
  const { organization, project, environments, userId } = useScope();
  const client = useQueryClient();
  const action = useAction();
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = environments?.items ?? [];
  const waiting =
    project !== null && (isMoving(project.state) || rows.some((row) => isMoving(row.state)));
  const org = organization?.id ?? "";
  const follow = useFollow(waiting, () => {
    void client.invalidateQueries({ queryKey: [userId, org] });
  });
  if (organization === null || project === null) return null;

  const manages = organization.role === "owner" || organization.role === "admin";
  const at = { org, project: project.id };
  const show = (next: Open): void => {
    action.clear();
    setNotice(null);
    setOpen(next);
  };
  const settled = async (text: string): Promise<void> => {
    setOpen(null);
    setNotice(text);
    await client.invalidateQueries({ queryKey: [userId, org] });
  };

  const renameProject = async (name: string): Promise<void> => {
    const result = await action.run(`projects.rename ${project.id} ${name}`, (key) =>
      call("projects.rename", { params: at, body: { name }, idempotencyKey: key }),
    );
    if (result.ok) await settled(`The project is now named ${name}.`);
  };
  const createEnvironment = async (name: string): Promise<void> => {
    const result = await action.run(`environments.create ${project.id} ${name}`, (key) =>
      call("environments.create", { params: at, body: { name }, idempotencyKey: key }),
    );
    if (result.ok) {
      await settled(
        `The environment ${name} is created. It is pending until the server has prepared it and says active.`,
      );
    }
  };
  const renameEnvironment = async (id: string, name: string): Promise<void> => {
    const result = await action.run(`environments.rename ${id} ${name}`, (key) =>
      call("environments.rename", {
        params: { ...at, env: id },
        body: { name },
        idempotencyKey: key,
      }),
    );
    if (result.ok) await settled(`The environment is now named ${name}.`);
  };

  const projectTarget: Target = {
    kind: "project",
    ...at,
    name: project.name,
    environments: rows
      .filter((row) => row.state !== "archived")
      .map((row) => ({ id: row.id, name: row.name })),
  };
  const environmentTarget = (row: Environment): Target => ({
    kind: "environment",
    ...at,
    env: row.id,
    name: row.name,
    environments: [{ id: row.id, name: row.name }],
  });
  // An environment's own actions need a project that is open.
  const projectOpen = nameable(project.state);

  return (
    <>
      <PageHeader
        page={PAGES.project}
        title={project.name}
        meta={
          <>
            <StateBadge kind="resource" state={project.state} />
            <ScopeIds project={project} />
          </>
        }
        actions={
          manages && open === null ? (
            <>
              {nameable(project.state) ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      show({ kind: "new-environment" });
                    }}
                  >
                    <Icon name="plus" />
                    New environment
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      show({ kind: "rename-project" });
                    }}
                  >
                    Rename project
                  </button>
                </>
              ) : null}
              {project.state === "active" ? (
                <button
                  type="button"
                  onClick={() => {
                    show({ kind: "archive", target: projectTarget });
                  }}
                >
                  Archive project
                </button>
              ) : null}
              {project.state === "archived" ? (
                <button
                  type="button"
                  onClick={() => {
                    show({ kind: "reactivate", target: projectTarget });
                  }}
                >
                  Reactivate project
                </button>
              ) : null}
            </>
          ) : undefined
        }
      />
      <ReviewNote state={project.state} reason={project.reviewReason} />
      <FollowNote waiting={waiting} follow={follow} />
      {notice === null ? null : <p role="status">{notice}</p>}

      {open?.kind === "rename-project" ? (
        <NameForm
          label="New name"
          initial={project.name}
          submit="Rename"
          rule={PROJECT_NAME_RULE}
          problem={projectNameProblem}
          within="this organization"
          busy={action.busy || action.held}
          failure={action.failure}
          action="rename the project"
          onSubmit={(name) => void renameProject(name)}
          onCancel={() => {
            show(null);
          }}
        />
      ) : null}
      {open?.kind === "new-environment" ? (
        <NameForm
          label="Environment name"
          submit="Create environment"
          rule={ENVIRONMENT_NAME_RULE}
          problem={environmentNameProblem}
          within="this project"
          busy={action.busy || action.held}
          failure={action.failure}
          action="create the environment"
          onSubmit={(name) => void createEnvironment(name)}
          onCancel={() => {
            show(null);
          }}
        />
      ) : null}
      {open?.kind === "rename-environment" ? (
        <NameForm
          key={open.id}
          label="New name"
          initial={open.name}
          submit="Rename"
          rule={ENVIRONMENT_NAME_RULE}
          problem={environmentNameProblem}
          within="this project"
          busy={action.busy || action.held}
          failure={action.failure}
          action="rename the environment"
          onSubmit={(name) => void renameEnvironment(open.id, name)}
          onCancel={() => {
            show(null);
          }}
        />
      ) : null}
      {open?.kind === "archive" ? (
        <ArchiveDialog
          userId={userId}
          target={open.target}
          onDone={(text) => void settled(text)}
          onCancel={() => {
            show(null);
          }}
        />
      ) : null}
      {open?.kind === "reactivate" ? (
        <ReactivateDialog
          userId={userId}
          target={open.target}
          onDone={(text) => void settled(text)}
          onCancel={() => {
            show(null);
          }}
        />
      ) : null}

      <h2>Environments</h2>
      <p>
        Secrets, machine credentials and Connect an application belong to one environment: open them
        from the environment&apos;s row.
      </p>
      {environments?.more === true ? (
        <p role="status">Only the first {rows.length} environments are shown.</p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No environments you can see"
          text="An environment is one set of secrets of this project, such as development or production."
          learn="projects-environments"
        />
      ) : (
        <div className="scroll">
          <table aria-label="Environments">
            <thead>
              <tr>
                <th scope="col">Environment</th>
                <th scope="col">State</th>
                <th scope="col">Id</th>
                <th scope="col">Open</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <Link to={webPath("secrets", { ...at, env: row.id })}>{row.name}</Link>
                  </th>
                  <td>
                    <StateBadge kind="resource" state={row.state} />
                    <ReviewNote state={row.state} reason={row.reviewReason} />
                  </td>
                  <td>
                    <code>{row.id}</code>
                  </td>
                  <td>
                    <EnvironmentLinks
                      org={at.org}
                      project={at.project}
                      env={row.id}
                      name={row.name}
                    />
                  </td>
                  <td>
                    {manages && projectOpen && open === null ? (
                      <div className="actions">
                        {nameable(row.state) ? (
                          <button
                            type="button"
                            onClick={() => {
                              show({ kind: "rename-environment", id: row.id, name: row.name });
                            }}
                          >
                            Rename
                          </button>
                        ) : null}
                        {row.state === "active" ? (
                          <button
                            type="button"
                            onClick={() => {
                              show({ kind: "archive", target: environmentTarget(row) });
                            }}
                          >
                            Archive
                          </button>
                        ) : null}
                        {row.state === "archived" ? (
                          <button
                            type="button"
                            onClick={() => {
                              show({ kind: "reactivate", target: environmentTarget(row) });
                            }}
                          >
                            Reactivate
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
