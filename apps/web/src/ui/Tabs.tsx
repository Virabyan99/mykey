// The environments of the project across the top of every environment screen
// (D-70): a choice of environment keeps the section the owner is in. They are
// links between addresses, not panels of one page, so they are a navigation
// with the current one marked, and the browser's back and forward work.
import { webPath } from "@mykey/contracts";
import { Link } from "../router.tsx";
import type { Scope } from "../state/scope.tsx";

/** The sections an environment has; a secret's page keeps the secrets list. */
const KEEPS = new Set(["secrets", "import", "credentials", "operations", "connect"]);

export function EnvironmentTabs(props: { scope: Scope; current: string }) {
  const { organization, project, environment, environments } = props.scope;
  if (organization === null || project === null || environment === null) return null;
  const items = environments?.items ?? [];
  if (items.length === 0) return null;
  const section = KEEPS.has(props.current) ? props.current : "secrets";
  return (
    <nav className="tabs" aria-label="Environments">
      <ul>
        {items.map((row) => (
          <li key={row.id}>
            <Link
              to={webPath(section, { org: organization.id, project: project.id, env: row.id })}
              current={row.id === environment.id}
            >
              {row.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
