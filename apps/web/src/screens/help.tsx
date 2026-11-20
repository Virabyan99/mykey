// The first-run guide (FR-1.89): from an empty workspace to an application
// started with its secrets, in six steps. Each step names the screen that
// does it or the runbook that describes it. A runbook is a file of the
// repository, named by its path: the workspace serves no documentation. The
// guide holds no address, no token and no value of any deployment.
import { webPath } from "@mykey/contracts";
import type { ReactNode } from "react";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";

function Runbook(props: { file: string }) {
  return <code>docs/runbooks/{props.file}</code>;
}

export function Help() {
  const { organizations } = useScope();
  const first = organizations[0];
  const overview: ReactNode =
    first === undefined ? (
      "the overview"
    ) : (
      <Link to={webPath("overview", { org: first.id })}>the overview</Link>
    );
  const activity: ReactNode =
    first === undefined ? (
      "the activity screen"
    ) : (
      <Link to={webPath("activity", { org: first.id })}>the activity screen</Link>
    );

  return (
    <>
      <h1>Help</h1>
      <h2 id="first-run">First run</h2>
      <p>
        From an empty workspace to an application that starts with its secrets and without a{" "}
        <code>.env</code> file.
      </p>
      <ol aria-labelledby="first-run" className="guide">
        <li>
          <strong>Make a project.</strong> On {overview}, press New project. The server prepares its
          first environment, <code>development</code>; both are pending until the server says
          active.
        </li>
        <li>
          <strong>Put the secrets in.</strong> Open the environment from the overview. Add them one
          by one under Secrets, or import a dotenv file under Import and export: the preview shows
          what would change before anything is written.
        </li>
        <li>
          <strong>Issue a machine credential.</strong> Under Machine credentials, for that
          environment. Its token is shown once. The rules for it are in{" "}
          <Runbook file="machine-credentials.md" />.
        </li>
        <li>
          <strong>Install the CLI on the machine that runs the application.</strong> Follow{" "}
          <Runbook file="consumer-local.md" />, steps 1 to 6: it checks every file it downloads
          before it installs anything.
        </li>
        <li>
          <strong>Store the token and start the application.</strong> The same runbook, steps 8 to
          10. The token is typed on standard input into a file only that user can read. The launcher
          starts the application with the secrets as environment variables of its process; if the
          complete set cannot be read, nothing starts.
        </li>
        <li>
          <strong>Check what happened.</strong> On {activity}: who issued the credential, and each
          time a person revealed, changed or exported a secret.
        </li>
      </ol>

      <h2>Reference</h2>
      <ul>
        <li>
          <a href="/v1/reference">The API reference</a>: every route, its request and its answers.
        </li>
        <li>
          What this stage does not do, and what to do instead: <Runbook file="known-limits.md" />.
        </li>
        <li>
          The dotenv format an import reads and an export writes:{" "}
          <Runbook file="dotenv-format-v1.md" />.
        </li>
        <li>
          Deploying an application with its secrets on a server:{" "}
          <Runbook file="consumer-deploy.md" />.
        </li>
      </ul>
    </>
  );
}
