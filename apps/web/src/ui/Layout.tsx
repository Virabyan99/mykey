// The frame of every workspace screen (FR-1.89): the scope bar that names the
// organization, the project and the environment, and the navigation of what
// can be done there. The screen is shown only when the server has listed
// everything the address names.
import { useQueryClient } from "@tanstack/react-query";
import { webPath } from "@mykey/contracts";
import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import { signOut, type SessionView } from "../api/auth.ts";
import { call } from "../api/client.ts";
import { SESSION_KEY } from "../api/query.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { stateLabel } from "../labels.ts";
import { Link, navigate } from "../router.tsx";
import { ScopeProvider, useScopeState, type Scope } from "../state/scope.tsx";
import { useSessionControl } from "../state/session.tsx";
import { Loading } from "./StateBadge.tsx";

const ACTIVITY_EVERY_MS = 60_000;

/**
 * Tells the server the owner is here (session.activity), at most once a
 * minute and only when a key or the pointer was used: an open tab alone does
 * not keep a session alive.
 */
function useActivity(): void {
  const client = useQueryClient();
  useEffect(() => {
    let last = 0;
    const report = (): void => {
      const now = Date.now();
      if (now - last < ACTIVITY_EVERY_MS) return;
      last = now;
      void call("session.activity").then((result) => {
        if (!result.ok && result.failure.kind === "api" && result.failure.status === 401) {
          void client.invalidateQueries({ queryKey: SESSION_KEY });
        }
      });
    };
    window.addEventListener("keydown", report);
    window.addEventListener("pointerdown", report);
    return () => {
      window.removeEventListener("keydown", report);
      window.removeEventListener("pointerdown", report);
    };
  }, [client]);
}

const suffix = (kind: "organization" | "resource", state: string): string =>
  state === "active" ? "" : ` (${stateLabel(kind, state).text})`;

function ScopeBar(props: { scope: Scope | null; params: Readonly<Record<string, string>> }) {
  const ids = { organization: useId(), project: useId(), environment: useId() };
  const { scope, params } = props;
  const org = scope?.organization?.id;
  const project = scope?.project?.id;

  const chooseOrganization = (event: ChangeEvent<HTMLSelectElement>): void => {
    navigate(event.target.value === "" ? "/" : webPath("overview", { org: event.target.value }));
  };
  const chooseProject = (event: ChangeEvent<HTMLSelectElement>): void => {
    if (org === undefined) return;
    navigate(
      event.target.value === ""
        ? webPath("overview", { org })
        : webPath("project", { org, project: event.target.value }),
    );
  };
  const chooseEnvironment = (event: ChangeEvent<HTMLSelectElement>): void => {
    if (org === undefined || project === undefined) return;
    navigate(
      event.target.value === ""
        ? webPath("project", { org, project })
        : webPath("secrets", { org, project, env: event.target.value }),
    );
  };

  return (
    <nav className="scope" aria-label="Scope">
      <div className="scope-field">
        <label htmlFor={ids.organization}>Organization</label>
        <select id={ids.organization} value={org ?? ""} onChange={chooseOrganization}>
          <option value="">{params.org === undefined ? "All organizations" : "Not found"}</option>
          {(scope?.organizations ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.id.slice(0, 8)} · {row.role}
              {suffix("organization", row.state)}
            </option>
          ))}
        </select>
      </div>
      <div className="scope-field">
        <label htmlFor={ids.project}>Project</label>
        <select
          id={ids.project}
          value={project ?? ""}
          onChange={chooseProject}
          disabled={org === undefined || (scope?.projects ?? null) === null}
        >
          <option value="">{params.project === undefined ? "All projects" : "Not found"}</option>
          {(scope?.projects?.items ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {suffix("resource", row.state)}
            </option>
          ))}
          {scope?.projects?.more === true ? (
            <option disabled>More exist: see the overview</option>
          ) : null}
        </select>
      </div>
      <div className="scope-field">
        <label htmlFor={ids.environment}>Environment</label>
        <select
          id={ids.environment}
          value={scope?.environment?.id ?? ""}
          onChange={chooseEnvironment}
          disabled={project === undefined || (scope?.environments ?? null) === null}
        >
          <option value="">{params.env === undefined ? "All environments" : "Not found"}</option>
          {(scope?.environments?.items ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {suffix("resource", row.state)}
            </option>
          ))}
          {scope?.environments?.more === true ? (
            <option disabled>More exist: see the project</option>
          ) : null}
        </select>
      </div>
    </nav>
  );
}

function Sections(props: { scope: Scope; current: string }) {
  const org = props.scope.organization?.id;
  const project = props.scope.project?.id;
  const env = props.scope.environment?.id;
  const items: { id: string; text: string; to: string }[] = [];
  if (org !== undefined) {
    items.push(
      { id: "overview", text: "Overview", to: webPath("overview", { org }) },
      { id: "activity", text: "Activity", to: webPath("activity", { org }) },
      { id: "audit", text: "Audit", to: webPath("audit", { org }) },
    );
  }
  if (org !== undefined && project !== undefined && env !== undefined) {
    const at = { org, project, env };
    items.push(
      { id: "secrets", text: "Secrets", to: webPath("secrets", at) },
      { id: "import", text: "Import", to: webPath("import", at) },
      { id: "credentials", text: "Machine credentials", to: webPath("credentials", at) },
      { id: "operations", text: "Operations", to: webPath("operations", at) },
    );
  }
  items.push(
    { id: "account", text: "Account", to: webPath("account", {}) },
    { id: "help", text: "Help", to: webPath("help", {}) },
  );
  return (
    <nav className="sections" aria-label="Sections">
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link to={item.to} current={item.id === props.current}>
              {item.text}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Layout(props: {
  session: SessionView;
  route: { id: string; params: Readonly<Record<string, string>> };
  children: ReactNode;
}) {
  useActivity();
  const control = useSessionControl();
  const [notGone, setNotGone] = useState<Failure | null>(null);
  const state = useScopeState(props.session.userId, props.route.params);
  // "Signed out" is said only when the server has ended the session.
  const leave = async (): Promise<void> => {
    const result = await signOut();
    if (result.ok) control.drop("signed_out");
    else setNotGone(result.failure);
  };
  const scope = state.status === "ready" || state.status === "unknown" ? state.scope : null;
  return (
    <div className="frame">
      <header className="top">
        <p className="brand">MyKey</p>
        <ScopeBar scope={scope} params={props.route.params} />
        <p className="who">
          {props.session.email}{" "}
          <button
            type="button"
            onClick={() => {
              void leave();
            }}
          >
            Sign out
          </button>
        </p>
      </header>
      {scope === null ? null : <Sections scope={scope} current={props.route.id} />}
      <main>
        {notGone === null ? null : (
          <ErrorPanel failure={notGone} action="sign out (you are still signed in)" />
        )}
        {state.status === "loading" ? <Loading what="the workspace" /> : null}
        {state.status === "error" ? (
          <ErrorPanel failure={state.failure} action="open this page" onReload={state.reload} />
        ) : null}
        {state.status === "unknown" ? (
          <ErrorPanel
            failure={{
              kind: "api",
              status: 404,
              code: "not_found",
              message: "",
              requestId: null,
              operationId: null,
              details: null,
              retryAfterSeconds: null,
            }}
            action="open this page"
          />
        ) : null}
        {state.status === "ready" ? (
          <ScopeProvider value={state.scope}>{props.children}</ScopeProvider>
        ) : null}
      </main>
    </div>
  );
}
