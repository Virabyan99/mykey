// The frame of every workspace screen (FR-1.89, D-70): a sidebar that always
// shows where the owner is and what can be done there, a top bar with the
// breadcrumbs, and the content. Below 1024 px the sidebar is a drawer opened
// by "Menu". The screen is shown only when the server has listed everything
// the address names (useScopeState), and the sidebar names only rows the
// server returned: navigation never implies a permission the server would
// refuse (the role only spares a request the server would refuse anyway).
import { useQueryClient } from "@tanstack/react-query";
import { webPath } from "@mykey/contracts";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { signOut, type SessionView } from "../api/auth.ts";
import { call } from "../api/client.ts";
import { SESSION_KEY } from "../api/query.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { ContextHelp } from "../help/ContextHelp.tsx";
import { Palette } from "../palette/Palette.tsx";
import type { Failure } from "../errors/explain.ts";
import { stateLabel } from "../labels.ts";
import { Link, navigate, onNavigate } from "../router.tsx";
import { ask } from "../state/intent.ts";
import {
  ScopeProvider,
  useProjects,
  useScopeState,
  type Organization,
  type Scope,
} from "../state/scope.tsx";
import { useSessionControl } from "../state/session.tsx";
import { Breadcrumbs } from "./Breadcrumbs.tsx";
import { IdChip } from "./IdChip.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Loading } from "./StateBadge.tsx";
import { EnvironmentTabs } from "./Tabs.tsx";

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

/** The organization the frame speaks of: the address's, or the only one there is. */
function frameOrganization(scope: Scope | null): Organization | null {
  if (scope === null) return null;
  if (scope.organization !== null) return scope.organization;
  return scope.organizations.length === 1 ? (scope.organizations[0] ?? null) : null;
}

function Item(props: { to: string; icon: IconName; current: boolean; children: ReactNode }) {
  return (
    <li>
      <Link to={props.to} current={props.current}>
        <Icon name={props.icon} />
        <span>{props.children}</span>
      </Link>
    </li>
  );
}

/** The environment sections, in the order the owner meets them. */
const ENVIRONMENT_SECTIONS: readonly { id: string; text: string; icon: IconName }[] = [
  { id: "secrets", text: "Secrets", icon: "lockKeyhole" },
  { id: "import", text: "Import and export", icon: "arrowUpDown" },
  { id: "credentials", text: "Machine credentials", icon: "server" },
  { id: "operations", text: "Operations", icon: "listChecks" },
  { id: "connect", text: "Connect an application", icon: "plug" },
];

function Sidebar(props: {
  scope: Scope | null;
  session: SessionView;
  current: string;
  onSignOut: () => void;
}) {
  const { scope, current } = props;
  const org = frameOrganization(scope);
  // The projects of the frame's organization: the same query, and the same rows, as the scope's.
  const listed = useProjects(props.session.userId, org?.id);
  const projects = scope?.organization !== null ? (scope?.projects ?? null) : (listed.data ?? null);
  const project = scope?.project ?? null;
  // Task test (host-v0.9.1): with a project open and no environment yet, the
  // sections of its first environment are listed, so they are never hidden.
  const environment = scope?.environment ?? scope?.environments?.items[0] ?? null;
  const manages = org !== null && (org.role === "owner" || org.role === "admin");

  const newProject = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (org === null) return;
    event.preventDefault();
    ask("new-project");
    navigate(webPath("overview", { org: org.id }));
  };

  return (
    <>
      <p className="brand">
        <Icon name="keyRound" large />
        MyKey
      </p>
      {org === null ? null : (
        <div className="org-block">
          <p className="label">Organization</p>
          <p>
            Your role: <strong>{org.role}</strong>
            {suffix("organization", org.state)}
          </p>
          <IdChip of="organization" id={org.id} />
          {(scope?.organizations.length ?? 0) > 1 ? (
            <p>
              <Link to="/">Switch organization</Link>
            </p>
          ) : null}
        </div>
      )}
      <nav aria-label="Sections">
        <ul className="nav-list">
          <Item
            to={org === null ? "/" : webPath("overview", { org: org.id })}
            icon="house"
            current={current === "overview" || current === "home"}
          >
            Home
          </Item>
        </ul>
        {org === null ? null : (
          <div className="nav-group">
            <p className="nav-heading">Projects</p>
            <ul className="nav-list">
              {(projects?.items ?? []).map((row) => (
                <li key={row.id}>
                  <Link
                    to={webPath("project", { org: org.id, project: row.id })}
                    current={current === "project" && project?.id === row.id}
                  >
                    <Icon name={project?.id === row.id ? "folderOpen" : "folder"} />
                    <span>
                      {row.name}
                      {suffix("resource", row.state)}
                    </span>
                  </Link>
                  {project?.id === row.id && (scope?.environments?.items.length ?? 0) > 0 ? (
                    <ul className="nav-list" aria-label={`Environments of ${row.name}`}>
                      {(scope?.environments?.items ?? []).map((env) => (
                        <Item
                          key={env.id}
                          to={webPath("secrets", { org: org.id, project: row.id, env: env.id })}
                          icon="layers"
                          current={false}
                        >
                          {env.name}
                          {suffix("resource", env.state)}
                        </Item>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
              {projects?.more === true ? (
                <li className="muted">More exist: they are listed on Home.</li>
              ) : null}
              {manages ? (
                <li>
                  <a href={webPath("overview", { org: org.id })} onClick={newProject}>
                    <Icon name="plus" />
                    <span>New project</span>
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        )}
        {org === null || project === null || environment === null ? null : (
          <div className="nav-group">
            <p className="nav-heading">In {environment.name}</p>
            <ul className="nav-list">
              {ENVIRONMENT_SECTIONS.map((section) => (
                <Item
                  key={section.id}
                  to={webPath(section.id, {
                    org: org.id,
                    project: project.id,
                    env: environment.id,
                  })}
                  icon={section.icon}
                  current={
                    current === section.id || (section.id === "secrets" && current === "secret")
                  }
                >
                  {section.text}
                </Item>
              ))}
            </ul>
          </div>
        )}
        {org === null ? null : (
          <div className="nav-group">
            <p className="nav-heading">Organization</p>
            <ul className="nav-list">
              <Item
                to={webPath("activity", { org: org.id })}
                icon="activity"
                current={current === "activity"}
              >
                Activity
              </Item>
              <Item
                to={webPath("audit", { org: org.id })}
                icon="scrollText"
                current={current === "audit"}
              >
                Audit
              </Item>
              {/* Session 11: owners and admins issue automation credentials; nobody else can list them. */}
              {manages ? (
                <Item
                  to={webPath("automation", { org: org.id })}
                  icon="terminal"
                  current={current === "automation"}
                >
                  Automation
                </Item>
              ) : null}
            </ul>
          </div>
        )}
        <div className="nav-foot">
          <ul className="nav-list">
            <Item
              to={webPath("help")}
              icon="bookOpen"
              current={current === "help" || current === "help-article"}
            >
              Help centre
            </Item>
            <Item to={webPath("account")} icon="user" current={current === "account"}>
              Account
            </Item>
          </ul>
        </div>
      </nav>
      <p className="who">{props.session.email}</p>
      <div className="actions">
        <button type="button" onClick={props.onSignOut}>
          <Icon name="logOut" />
          Sign out
        </button>
      </div>
    </>
  );
}

/** The sidebar as a modal drawer below 1024 px. Closed on Escape, on a link, and on a change of address. */
function Drawer(props: { onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { onClose } = props;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);
  useEffect(() => onNavigate(onClose), [onClose]);
  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-label="Menu"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="actions">
        <button type="button" className="quiet" aria-label="Close the menu" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {props.children}
    </dialog>
  );
}

export function AppShell(props: {
  session: SessionView;
  route: { id: string; params: Readonly<Record<string, string>> };
  children: ReactNode;
}) {
  useActivity();
  const control = useSessionControl();
  const [notGone, setNotGone] = useState<Failure | null>(null);
  const [drawer, setDrawer] = useState(false);
  const state = useScopeState(props.session.userId, props.route.params);
  // "Signed out" is said only when the server has ended the session.
  const leave = async (): Promise<void> => {
    const result = await signOut();
    if (result.ok) control.drop("signed_out");
    else setNotGone(result.failure);
  };
  const scope = state.status === "ready" || state.status === "unknown" ? state.scope : null;
  const sidebar = (
    <Sidebar
      scope={scope}
      session={props.session}
      current={props.route.id}
      onSignOut={() => {
        void leave();
      }}
    />
  );
  const closeDrawer = (): void => {
    setDrawer(false);
  };
  return (
    <div className="shell">
      <a className="skip" href="#content">
        Skip to the content
      </a>
      <aside className="sidebar">{sidebar}</aside>
      <div className="column">
        <header className="topbar">
          <button
            type="button"
            className="menu-button"
            aria-haspopup="dialog"
            onClick={() => {
              setDrawer(true);
            }}
          >
            <Icon name="menu" />
            Menu
          </button>
          <Breadcrumbs
            scope={scope}
            current={props.route.id}
            {...(props.route.id === "secret" && props.route.params.name !== undefined
              ? { secret: props.route.params.name }
              : {})}
          />
          <div className="tools">
            <Palette
              scope={scope}
              onSignOut={() => {
                void leave();
              }}
            />
            <ContextHelp route={props.route.id} />
          </div>
        </header>
        {drawer ? <Drawer onClose={closeDrawer}>{sidebar}</Drawer> : null}
        <main id="content" tabIndex={-1}>
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
            <ScopeProvider value={state.scope}>
              <EnvironmentTabs scope={state.scope} current={props.route.id} />
              {props.children}
            </ScopeProvider>
          ) : null}
        </main>
      </div>
    </div>
  );
}
