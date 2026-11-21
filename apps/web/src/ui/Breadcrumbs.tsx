// Where the page is (FR-1.89, the walkthrough's finding b): the organization,
// the project, the environment and the secret, each a link and each with its
// id one click from the clipboard. Every name is a row the server listed for
// this caller (useScopeState); nothing is named before it was read.
import { webPath } from "@mykey/contracts";
import { Link } from "../router.tsx";
import type { Scope } from "../state/scope.tsx";
import { IdChip } from "./IdChip.tsx";

export function Breadcrumbs(props: {
  scope: Scope | null;
  /** The secret's name, on a secret's page. */
  secret?: string;
  current: string;
}) {
  const org = props.scope?.organization ?? null;
  const project = props.scope?.project ?? null;
  const environment = props.scope?.environment ?? null;
  if (org === null) {
    return <nav className="crumbs" aria-label="Scope" />;
  }
  const at = { org: org.id };
  const last = (level: "org" | "project" | "env" | "secret"): boolean => {
    if (props.secret !== undefined) return level === "secret";
    if (environment !== null) return level === "env" && props.current === "secrets";
    if (project !== null) return level === "project" && props.current === "project";
    return level === "org" && props.current === "overview";
  };
  return (
    <nav className="crumbs" aria-label="Scope">
      <ol>
        <li>
          <Link to={webPath("overview", at)} current={last("org")}>
            Organization
          </Link>
          <IdChip of="organization" id={org.id} />
        </li>
        {project === null ? null : (
          <li>
            <Link to={webPath("project", { ...at, project: project.id })} current={last("project")}>
              {project.name}
            </Link>
            <IdChip of="project" id={project.id} />
          </li>
        )}
        {project === null || environment === null ? null : (
          <li>
            <Link
              to={webPath("secrets", { ...at, project: project.id, env: environment.id })}
              current={last("env")}
            >
              {environment.name}
            </Link>
            <IdChip of="environment" id={environment.id} />
          </li>
        )}
        {project === null || environment === null || props.secret === undefined ? null : (
          <li>
            <Link
              to={webPath("secret", {
                ...at,
                project: project.id,
                env: environment.id,
                name: props.secret,
              })}
              current
            >
              {props.secret}
            </Link>
          </li>
        )}
      </ol>
    </nav>
  );
}
