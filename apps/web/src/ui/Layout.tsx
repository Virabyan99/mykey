// The frame of every workspace screen (FR-1.89). Since Run 9.0 it is the
// AppShell (sidebar, breadcrumbs, content); this wrapper keeps the name the
// app imports and adds the top bar's tools.
import type { ReactNode } from "react";
import type { SessionView } from "../api/auth.ts";
import { AppShell } from "./AppShell.tsx";

export function Layout(props: {
  session: SessionView;
  route: { id: string; params: Readonly<Record<string, string>> };
  children: ReactNode;
}) {
  return (
    <AppShell session={props.session} route={props.route}>
      {props.children}
    </AppShell>
  );
}
