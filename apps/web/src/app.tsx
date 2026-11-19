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
import { Account } from "./screens/account.tsx";
import { Enroll } from "./screens/enroll.tsx";
import { Home } from "./screens/home.tsx";
import { Reset } from "./screens/reset.tsx";
import { SecondStep, SignIn } from "./screens/sign-in.tsx";
import { useFlow } from "./state/flow.ts";
import { useSession } from "./state/session.tsx";
import { useScope } from "./state/scope.tsx";
import { Layout } from "./ui/Layout.tsx";
import { Loading } from "./ui/StateBadge.tsx";

/** The screens later runs of Session 7 build; until then, the name of the place. */
const TITLES: Readonly<Record<string, string>> = {
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
  if (route.id === "account") return <Account />;
  if (route.id === "secret") return <h1>{route.params.name}</h1>;
  return <Place id={route.id} />;
}

/** Paths a complete session has nothing to do on. */
const OUTSIDE = new Set(["sign-in", "enroll"]);

export function App() {
  const path = usePath();
  const route = matchWebRoute(path);
  const session = useSession();
  const flow = useFlow();
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
  // A reset link is for someone who cannot sign in: it needs no session.
  if (route?.id === "reset") return <Reset />;
  if (session.status === "partial") {
    // The password only (rule 6): the second step, or the first set-up of it. Never a workspace screen.
    if (route?.id === "enroll" || session.session.phase === "enrollment") return <Enroll />;
    return <SecondStep />;
  }
  if (session.status === "none") {
    // A completed reset of kind `mfa` goes on to enrolment with a session the server does not show.
    if (flow.enrolAfterReset && route?.id === "enroll") return <Enroll />;
    return <SignIn />;
  }
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
