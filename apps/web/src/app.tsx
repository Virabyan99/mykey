// Which screen an address shows. Three questions, in this order: is the
// address one of the workspace's; who is asking (the server's answer); and
// only then the screen. Without a complete session no workspace screen is
// rendered and none of its data is requested.
import { useQueryClient } from "@tanstack/react-query";
import { matchWebRoute } from "@mykey/contracts";
import { useEffect, type ReactNode } from "react";
import { forgetData } from "./api/query.ts";
import { ErrorPanel } from "./errors/ErrorPanel.tsx";
import { navigate, usePath } from "./router.tsx";
import { Home } from "./screens/home.tsx";
import { SignIn } from "./screens/sign-in.tsx";
import { useSession } from "./state/session.tsx";
import { useScope } from "./state/scope.tsx";
import { Layout } from "./ui/Layout.tsx";
import { Loading } from "./ui/StateBadge.tsx";

/** The screens later runs of Session 7 build; until then, the name of the place. */
const TITLES: Readonly<Record<string, string>> = {
  account: "Account",
  help: "Help",
  overview: "Overview",
  activity: "Activity",
  audit: "Audit",
  secrets: "Secrets",
  import: "Import",
  credentials: "Machine credentials",
  operations: "Operations",
};

function Place(props: { id: string }) {
  const scope = useScope();
  if (props.id === "project") return <h1>{scope.project?.name}</h1>;
  return <h1>{TITLES[props.id] ?? "MyKey"}</h1>;
}

function screenOf(route: { id: string; params: Record<string, string> }): ReactNode {
  if (route.id === "home") return <Home />;
  if (route.id === "secret") return <h1>{route.params.name}</h1>;
  return <Place id={route.id} />;
}

/** Paths for someone who is not signed in yet. */
const OUTSIDE = new Set(["sign-in", "enroll", "reset"]);

export function App() {
  const path = usePath();
  const route = matchWebRoute(path);
  const session = useSession();
  const client = useQueryClient();
  const userId =
    session.status === "complete" || session.status === "partial" ? session.session.userId : null;

  // Another account, or none: nothing read for the previous one stays in memory.
  useEffect(() => {
    return () => {
      forgetData(client);
    };
  }, [client, userId]);

  const signedIn = session.status === "complete";
  // A complete session has nothing to do on the paths of signing in.
  const leave = signedIn && route !== null && OUTSIDE.has(route.id);
  useEffect(() => {
    if (leave) navigate("/", { replace: true });
  }, [leave]);

  if (session.status === "loading") {
    return (
      <main className="narrow">
        <Loading what="your session" />
      </main>
    );
  }
  if (session.status === "error") {
    return (
      <main className="narrow">
        <ErrorPanel
          failure={session.failure}
          action="open the workspace"
          onReload={session.reload}
        />
      </main>
    );
  }
  if (session.status !== "complete") return <SignIn />;
  if (route === null) {
    return (
      <main className="narrow">
        <h1>No such page</h1>
        <p>This address is not a page of the workspace.</p>
        <p>
          <a href="/">Go to the start</a>
        </p>
      </main>
    );
  }
  if (leave) return null;
  return (
    <Layout session={session.session} route={route}>
      {screenOf(route)}
    </Layout>
  );
}
