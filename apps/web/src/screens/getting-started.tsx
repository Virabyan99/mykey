// Getting started on Home (Run 9.0 Task E, FR-1.89, rule 11): six steps from
// an empty organization to an application that reads its secrets. A step is
// "Done" only when the server's own answer says so: the overview's projects
// and key counts, the credential summary, and a machine's successful read in
// the audit log. What the page cannot see (the CLI on another machine) is
// "Not checked", never done. The checklist hides itself when the steps the
// server can see are done, and can be hidden for the page's life (nothing is
// stored).
import { useQuery } from "@tanstack/react-query";
import { webPath } from "@mykey/contracts";
import { useState, type ReactNode } from "react";
import { call, need } from "../api/client.ts";
import { Link } from "../router.tsx";

type Mark = "done" | "next" | "not-checked" | "not-seen" | "unknown";

const MARK_TEXT: Readonly<Record<Mark, string>> = {
  done: "Done",
  next: "To do",
  "not-checked": "Not checked",
  "not-seen": "Not seen yet",
  unknown: "Not known",
};

/** Hidden by the owner: for the page's life only, never stored. */
let hiddenByOwner = false;

function Step(props: { mark: Mark; title: string; children: ReactNode }) {
  return (
    <li>
      <span className={`mark ${props.mark === "done" ? "tone-ok" : "muted"}`}>
        {MARK_TEXT[props.mark]}
      </span>
      <div>
        <p>
          <strong>{props.title}</strong>
        </p>
        {props.children}
      </div>
    </li>
  );
}

export function GettingStarted(props: { org: string; userId: string }) {
  const { org, userId } = props;
  const [hidden, setHidden] = useState(hiddenByOwner);
  const overview = useQuery({
    queryKey: [userId, org, "overview"],
    queryFn: () => need(call("overview.get", { params: { org } })),
  });
  const summary = useQuery({
    queryKey: [userId, org, "credentials-summary"],
    queryFn: () => need(call("credentials.summary", { params: { org } })),
  });
  // No credential is active: no machine can read, and the audit log is not asked
  // (D-61's bound of six requests for a Home load holds until there is one).
  const active = summary.data === undefined ? undefined : summary.data.byState.active > 0;
  const read = useQuery({
    queryKey: [userId, org, "machine-read"],
    enabled: active === true,
    queryFn: async () =>
      (
        await need(
          call("audit.list", {
            params: { org },
            query: { actorKind: "machine", outcome: "success", limit: 1 },
          }),
        )
      ).items.length > 0,
  });

  const projects = overview.data?.projects ?? null;
  const first = projects?.[0];
  const firstEnv = first?.environments[0];
  const where =
    first === undefined || firstEnv === undefined
      ? null
      : { org, project: first.id, env: firstEnv.id };

  const has = (known: boolean | undefined): Mark =>
    known === undefined ? "unknown" : known ? "done" : "next";
  const project = has(projects === null ? undefined : projects.length > 0);
  const secrets = has(
    projects === null
      ? undefined
      : projects.some((row) => row.environments.some((env) => (env.keys?.live ?? 0) > 0)),
  );
  const credential = has(active);
  const started: Mark =
    active === false
      ? "not-seen"
      : read.data === true
        ? "done"
        : read.data === false
          ? "not-seen"
          : "not-checked";

  const allDone =
    project === "done" && secrets === "done" && credential === "done" && started === "done";
  if (hidden || allDone) return null;

  return (
    <section className="card" aria-labelledby="getting-started">
      <h2 id="getting-started">Getting started</h2>
      <p className="hint">
        What is done comes from the server. A step the page cannot see says so.
      </p>
      <ol className="checklist">
        <Step mark={project} title="Create a project">
          <p>Press New project above. Its first environment, development, is made for you.</p>
        </Step>
        <Step mark={secrets} title="Add your secrets">
          <p>
            {where === null ? (
              "Open an environment, then Secrets: add them one by one, or import a .env file."
            ) : (
              <>
                Open <Link to={webPath("secrets", where)}>Secrets</Link> of {first?.name} /{" "}
                {firstEnv?.name}: add them one by one, or import a .env file.
              </>
            )}
          </p>
        </Step>
        <Step mark={credential} title="Issue a machine credential">
          <p>
            {where === null ? (
              "Under Machine credentials of the environment. Its token is shown once."
            ) : (
              <>
                Under <Link to={webPath("credentials", where)}>Machine credentials</Link>. Its token
                is shown once.
              </>
            )}
          </p>
        </Step>
        <Step mark="not-checked" title="Install the CLI">
          <p>
            The page cannot see the machine that runs your application. Check there:{" "}
            <code>secrets --version</code> prints the CLI&apos;s version.
          </p>
        </Step>
        <Step mark={started} title="Start your application">
          <p>
            {where === null ? (
              "Connect an application, on any environment, shows the commands with your ids filled in."
            ) : (
              <>
                <Link to={webPath("connect", where)}>Connect an application</Link> shows the
                commands with your ids filled in.
              </>
            )}{" "}
            {active === false
              ? "No credential is active yet, so no machine can read."
              : started === "not-seen"
                ? "The audit log shows no successful machine read in the last 30 days."
                : null}
          </p>
        </Step>
        <Step mark="not-checked" title="See what happened">
          <p>
            <Link to={webPath("activity", { org })}>Activity</Link> lists the issued credential and
            each read of the machine.
          </p>
        </Step>
      </ol>
      <div className="actions">
        <button
          type="button"
          className="quiet small"
          onClick={() => {
            hiddenByOwner = true;
            setHidden(true);
          }}
        >
          Hide the checklist
        </button>
      </div>
    </section>
  );
}
