// "Connect an application" (Run 9.0 Task E, P-160, P-161): the commands that
// start an application with this environment's secrets, from the runbooks,
// with the page's origin, the project's id and the environment's name in
// place. The token is never filled in: the page says where it comes from,
// and the step that stores it switches the terminal's echo off. "Copy"
// copies one command block, never a value.
import { webPath } from "@mykey/contracts";
import { useId, useState } from "react";
import { localSteps, serverSteps, type ConnectStep } from "../connect/commands.ts";
import {
  CONSUMER_DEPLOY as deployRunbook,
  CONSUMER_LOCAL as localRunbook,
} from "../connect/runbooks.ts";
import { CONNECT_STEPS, type ConnectStepId } from "../copy/connect.ts";
import { PAGES } from "../copy/pages.ts";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { Icon } from "../ui/icons.tsx";
import { Callout, PageHeader, ScopeIds } from "../ui/PageHeader.tsx";

function CodeBlock(props: { text: string; label: string }) {
  const [said, setSaid] = useState("");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text);
      setSaid("Copied");
    } catch {
      setSaid("Not copied: select the commands and copy them by hand");
    }
  };
  return (
    <div className="code-block">
      {/* The one-line token command scrolls sideways: the block takes the focus,
          so the keyboard can scroll it (axe: scrollable-region-focusable). */}
      <pre aria-label={props.label} tabIndex={0}>
        <code>{props.text}</code>
      </pre>
      <div className="code-actions">
        <span role="status" className="hint">
          {said}
        </span>
        <button
          type="button"
          className="small"
          onClick={() => {
            void copy();
          }}
        >
          <Icon name="copy" />
          Copy
        </button>
      </div>
    </div>
  );
}

function Steps(props: {
  steps: ConnectStep[];
  links: Partial<Record<string, string>>;
  application: boolean;
}) {
  return (
    <ol className="steps">
      {props.steps.map((step) => {
        // Without an application the variables block has no APP_ line, and its words name none.
        const key = step.id === "local-name" && !props.application ? "local-name-bare" : step.id;
        const words = CONNECT_STEPS[key as ConnectStepId];
        const link = props.links[step.id];
        return (
          <li key={step.id}>
            <h3>{words.title}</h3>
            <p>{words.text}</p>
            {step.warning === undefined ? null : (
              <Callout tone="warning">
                <p>{step.warning}</p>
              </Callout>
            )}
            {step.commands.map((command, index) => (
              <CodeBlock
                key={command}
                text={command}
                label={`${words.title}${step.commands.length > 1 ? `, part ${String(index + 1)}` : ""}`}
              />
            ))}
            {step.alternative === undefined ? null : (
              <details>
                <summary>With gh instead of curl</summary>
                {step.alternative.map((command) => (
                  <CodeBlock key={command} text={command} label={`${words.title}, with gh`} />
                ))}
              </details>
            )}
            {link === undefined ? null : (
              <p>
                <Link to={link}>
                  {step.id.endsWith("done") ? "Open Activity" : "Open Machine credentials"}
                </Link>
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Connect() {
  const { organization, project, environment } = useScope();
  const [tab, setTab] = useState<"local" | "server">("local");
  const [application, setApplication] = useState(true);
  const toggle = useId();
  if (organization === null || project === null || environment === null) return null;
  const at = { org: organization.id, project: project.id, env: environment.id };
  const fill = {
    origin: window.location.origin,
    project: project.id,
    environment: environment.name,
  };
  const links = {
    "local-issue": webPath("credentials", at),
    "server-store": webPath("credentials", at),
    "local-done": webPath("activity", { org: organization.id }),
    "server-done": webPath("activity", { org: organization.id }),
  };
  const steps =
    tab === "local"
      ? localSteps(localRunbook, fill, { application })
      : serverSteps(deployRunbook, fill);
  return (
    <>
      <PageHeader
        page={PAGES.connect}
        meta={<ScopeIds project={project} environment={environment} />}
      />
      <Callout title="What is filled in">
        <p>
          The service&apos;s address ({fill.origin}), the project&apos;s id and the
          environment&apos;s name ({environment.name}). The token is never filled in: you issue it
          under <Link to={webPath("credentials", at)}>Machine credentials</Link> and type it into a
          file.
        </p>
      </Callout>
      <nav className="tabs" aria-label="Where the application runs">
        <ul>
          <li>
            <button
              type="button"
              className="quiet"
              aria-pressed={tab === "local"}
              onClick={() => {
                setTab("local");
              }}
            >
              This computer (Linux, macOS, WSL)
            </button>
          </li>
          <li>
            <button
              type="button"
              className="quiet"
              aria-pressed={tab === "server"}
              onClick={() => {
                setTab("server");
              }}
            >
              A server (systemd or Docker)
            </button>
          </li>
        </ul>
      </nav>
      {tab === "local" ? (
        <p className="field">
          <label htmlFor={toggle}>
            <input
              id={toggle}
              type="checkbox"
              checked={!application}
              onChange={(event) => {
                setApplication(!event.target.checked);
              }}
            />{" "}
            No application yet: show a command that prints the names only
          </label>
        </p>
      ) : null}
      <Steps steps={steps} links={links} application={tab === "server" || application} />
    </>
  );
}
