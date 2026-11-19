// The scope of the address (FR-1.89): which organization, project and
// environment the page is looking at, read from the path and checked against
// what the server lists for this caller. A name in the scope bar is always a
// row the server returned; an id the server does not list is "not found",
// with nothing to tell whether it exists.
import { useQuery } from "@tanstack/react-query";
import {
  LIMITS,
  type EnvironmentsBody,
  type OrganizationsBody,
  type ProjectsBody,
} from "@mykey/contracts";
import { createContext, useContext } from "react";
import { call, failureOf, need } from "../api/client.ts";
import type { Failure } from "../errors/explain.ts";

export type Organization = OrganizationsBody["organizations"][number];
export type Project = ProjectsBody["projects"][number];
export type Environment = EnvironmentsBody["environments"][number];

/** A whole list for a selector, or its first thousand rows and the fact that there are more. */
export interface Listed<T> {
  items: T[];
  more: boolean;
}

const MAX_PAGES = 10;

async function everyPage<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<Listed<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const body = await page(cursor);
    items.push(...body.items);
    if (body.nextCursor === null) return { items, more: false };
    cursor = body.nextCursor;
  }
  return { items, more: true };
}

const limit = LIMITS.listing.maxLimit;

export function useOrganizations(userId: string) {
  return useQuery({
    queryKey: [userId, null, "organizations"],
    queryFn: async () => (await need(call("organizations.list"))).organizations,
  });
}

export function useProjects(userId: string, org: string | undefined) {
  return useQuery({
    queryKey: [userId, org, "projects"],
    enabled: org !== undefined,
    queryFn: () =>
      everyPage<Project>(async (cursor) => {
        const body = await need(
          call("projects.list", { params: { org: org ?? "" }, query: { limit, cursor } }),
        );
        return { items: body.projects, nextCursor: body.nextCursor };
      }),
  });
}

export function useEnvironments(
  userId: string,
  org: string | undefined,
  project: string | undefined,
) {
  return useQuery({
    queryKey: [userId, org, "environments", project],
    enabled: org !== undefined && project !== undefined,
    queryFn: () =>
      everyPage<Environment>(async (cursor) => {
        const body = await need(
          call("environments.list", {
            params: { org: org ?? "", project: project ?? "" },
            query: { limit, cursor },
          }),
        );
        return { items: body.environments, nextCursor: body.nextCursor };
      }),
  });
}

export interface Scope {
  userId: string;
  organizations: Organization[];
  organization: Organization | null;
  projects: Listed<Project> | null;
  project: Project | null;
  environments: Listed<Environment> | null;
  environment: Environment | null;
}

export type ScopeState =
  | { status: "loading" }
  | { status: "error"; failure: Failure; reload: () => void }
  /** The path names something the server does not list for this caller. */
  | { status: "unknown"; scope: Scope }
  | { status: "ready"; scope: Scope };

/** The scope of a path's parameters. Every list is read only when the path names its parent. */
export function useScopeState(
  userId: string,
  params: Readonly<Record<string, string>>,
): ScopeState {
  const { org, project, env } = params;
  const organizations = useOrganizations(userId);
  const organization = organizations.data?.find((candidate) => candidate.id === org) ?? null;
  // Nothing below an organization is asked for until the server has listed it.
  const projects = useProjects(userId, organization === null ? undefined : org);
  const projectRow = projects.data?.items.find((candidate) => candidate.id === project) ?? null;
  const environments = useEnvironments(
    userId,
    organization === null ? undefined : org,
    projectRow === null ? undefined : project,
  );
  const environment = environments.data?.items.find((candidate) => candidate.id === env) ?? null;

  const queries = [organizations, projects, environments];
  const failed = queries.filter((query) => query.isError);
  if (failed[0] !== undefined) {
    return {
      status: "error",
      failure: failureOf(failed[0].error),
      reload: () => {
        for (const query of failed) void query.refetch();
      },
    };
  }
  // A list the path needs and the page does not have yet: nothing is "not found" before it is read.
  if (
    organizations.data === undefined ||
    (organization !== null && projects.data === undefined) ||
    (projectRow !== null && environments.data === undefined)
  ) {
    return { status: "loading" };
  }
  const scope: Scope = {
    userId,
    organizations: organizations.data,
    organization,
    projects: projects.data ?? null,
    project: projectRow,
    environments: environments.data ?? null,
    environment,
  };
  const unknown =
    (org !== undefined && organization === null) ||
    (project !== undefined && projectRow === null) ||
    (env !== undefined && environment === null);
  return { status: unknown ? "unknown" : "ready", scope };
}

const ScopeContext = createContext<Scope | null>(null);
export const ScopeProvider = ScopeContext.Provider;

/** The scope of the screen being shown. Only inside the layout. */
export function useScope(): Scope {
  const scope = useContext(ScopeContext);
  if (scope === null) throw new Error("no scope outside the layout");
  return scope;
}
