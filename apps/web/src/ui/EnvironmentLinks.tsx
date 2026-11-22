// Run 9.0 (the owner's task test on host-v0.9.0, host-v0.9.1): secrets, machine
// credentials and Connect live inside an environment, and the owner could not
// find them from Home or a project. Every environment row now carries them as
// buttons, so the way in is visible wherever an environment is listed.
import { webPath } from "@mykey/contracts";
import { Link } from "../router.tsx";
import { Icon } from "./icons.tsx";

export function EnvironmentLinks(props: {
  org: string;
  project: string;
  env: string;
  name: string;
}) {
  const at = { org: props.org, project: props.project, env: props.env };
  return (
    <span className="env-go" role="group" aria-label={`Open ${props.name}`}>
      <Link className="go primary" to={webPath("secrets", at)}>
        <Icon name="lockKeyhole" />
        Secrets
      </Link>
      <Link className="go" to={webPath("credentials", at)}>
        <Icon name="server" />
        Machine credentials
      </Link>
      <Link className="go" to={webPath("connect", at)}>
        <Icon name="plug" />
        Connect an application
      </Link>
    </span>
  );
}
