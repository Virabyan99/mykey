// Archive and reactivate (FR-1.17, P-91, P-92): each behind a confirmation
// whose text is fixed, which names the resource and what the archive will
// revoke, and which needs the resource's name typed. What the dialog counts
// is read when it opens, from the same lists the owner can open; a number
// that could not be read is said to be unread, never shown as 0.
import { ACTIONS } from "../copy/actions.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, type OperationResponse } from "@mykey/contracts";
import { CallError, call, type CallResult } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { useAction } from "../state/use-action.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Loading } from "../ui/StateBadge.tsx";

export interface Target {
  kind: "project" | "environment";
  org: string;
  project: string;
  /** The environment's id, for an environment. */
  env?: string;
  name: string;
  /** The environments an archive closes: the one, or the project's that are not archived yet. */
  environments: readonly { id: string; name: string }[];
}

const MAX_PAGES = 10;
const limit = LIMITS.listing.maxLimit;

/** Counts over every page of a list; a failure instead of a number that would be too small. */
async function countPages(
  page: (cursor: string | undefined) => Promise<CallResult<{ count: number; next: string | null }>>,
): Promise<number | Failure> {
  let count = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const result = await page(cursor);
    if (!result.ok) return result.failure;
    count += result.body.count;
    if (result.body.next === null) return count;
    cursor = result.body.next;
  }
  return { kind: "transport", status: null };
}

interface Counts {
  name: string;
  /** Null: not read. */
  active: number | null;
  unfinished: number | null;
}

async function countEnvironment(
  target: Target,
  environment: { id: string; name: string },
): Promise<Counts> {
  const params = { org: target.org, project: target.project, env: environment.id };
  const active = await countPages(async (cursor) => {
    const result = await call("credentials.list", { params, query: { limit, cursor } });
    if (!result.ok) return result;
    const count = result.body.credentials.filter((row) => row.state === "active").length;
    return { ...result, body: { count, next: result.body.nextCursor } };
  });
  const unfinished = await countPages(async (cursor) => {
    const result = await call("operations.list", {
      params,
      query: { limit, cursor, state: "unfinished" },
    });
    if (!result.ok) return result;
    const count = result.body.operations.filter((row) => row.action === "credentials.issue").length;
    return { ...result, body: { count, next: result.body.nextCursor } };
  });
  // A session that ended is not "unread": the page forgets everything (query.ts).
  for (const answer of [active, unfinished]) {
    if (typeof answer !== "number" && answer.kind === "api" && answer.code === "unauthenticated") {
      throw new CallError(answer);
    }
  }
  return {
    name: environment.name,
    active: typeof active === "number" ? active : null,
    unfinished: typeof unfinished === "number" ? unfinished : null,
  };
}

function Total(props: {
  label: string;
  counts: readonly Counts[];
  pick: (row: Counts) => number | null;
}) {
  const unread = props.counts.filter((row) => props.pick(row) === null).map((row) => row.name);
  const sum = props.counts.reduce((total, row) => total + (props.pick(row) ?? 0), 0);
  return (
    <li>
      {props.label}:{" "}
      {unread.length === 0
        ? sum
        : `could not be read for ${unread.join(", ")}${props.counts.length > unread.length ? `; ${String(sum)} in the others` : ""}`}
    </li>
  );
}

const routeOf = (target: Target, verb: "archive" | "reactivate") =>
  target.kind === "project" ? (`projects.${verb}` as const) : (`environments.${verb}` as const);
const paramsOf = (target: Target): Record<string, string> => ({
  org: target.org,
  project: target.project,
  ...(target.env === undefined ? {} : { env: target.env }),
});

/** What the screen says after the server answered. */
function archiveNotice(target: Target, status: number, body: OperationResponse): string {
  const revoked = body.result?.credentialsRevoked;
  if (status === 200 && body.result?.state === "archived" && typeof revoked === "number") {
    return `The ${target.kind} ${target.name} is archived. ${String(revoked)} ${revoked === 1 ? "credential" : "credentials"} revoked.`;
  }
  return `The archive of the ${target.kind} ${target.name} is running: the server is still revoking credentials. Operation ${body.operationId}.`;
}

export function ArchiveDialog(props: {
  userId: string;
  target: Target;
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const { target, userId } = props;
  const client = useQueryClient();
  const action = useAction();
  const facts = useQuery({
    queryKey: [userId, target.org, "archive-facts", target.kind, target.env ?? target.project],
    queryFn: () =>
      Promise.all(target.environments.map((environment) => countEnvironment(target, environment))),
    // Read when the dialog opens, every time: these numbers are about now.
    staleTime: 0,
    gcTime: 0,
  });

  const archive = async (): Promise<void> => {
    const route = routeOf(target, "archive");
    // A 202 is read here: the notice below prints that the operation is still running.
    const result = await action.run(
      `${route} ${target.env ?? target.project}`,
      (key) =>
        call(route, { params: paramsOf(target), body: { confirmed: true }, idempotencyKey: key }),
      { unfinished: "caller" },
    );
    // Whatever the answer, the lists are read again: the server's state is the one shown.
    await client.invalidateQueries({ queryKey: [userId, target.org] });
    if (result.ok) props.onDone(archiveNotice(target, result.status, result.body));
  };

  return (
    <ConfirmDialog
      title={`Archive the ${target.kind} ${target.name}`}
      name={target.name}
      confirm="Archive"
      busy={action.busy || action.held}
      blocked={facts.isPending}
      onConfirm={() => void archive()}
      onCancel={props.onCancel}
    >
      <p>{ACTIONS.archive[target.kind]}</p>
      {facts.isPending ? <Loading what="what the archive revokes" /> : null}
      {facts.isError ? (
        <p>
          What the archive revokes could not be read. The archive itself does not depend on these
          numbers.
        </p>
      ) : null}
      {facts.data === undefined ? null : (
        <ul className="facts">
          {target.kind === "project" ? (
            <li>
              Environments affected:{" "}
              {target.environments.length === 0
                ? "none"
                : target.environments.map((row) => row.name).join(", ")}
            </li>
          ) : null}
          <Total
            label="Active machine credentials that will be revoked"
            counts={facts.data}
            pick={(row) => row.active}
          />
          <Total
            label="Issuances not finished"
            counts={facts.data}
            pick={(row) => row.unfinished}
          />
        </ul>
      )}
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action={`archive the ${target.kind}`} />
      )}
    </ConfirmDialog>
  );
}

export function ReactivateDialog(props: {
  userId: string;
  target: Target;
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const { target, userId } = props;
  const client = useQueryClient();
  const action = useAction();

  const reactivate = async (): Promise<void> => {
    const route = routeOf(target, "reactivate");
    // A 202 is read here: the notice below prints that the operation is still running.
    const result = await action.run(
      `${route} ${target.env ?? target.project}`,
      (key) =>
        call(route, { params: paramsOf(target), body: { confirmed: true }, idempotencyKey: key }),
      { unfinished: "caller" },
    );
    await client.invalidateQueries({ queryKey: [userId, target.org] });
    if (!result.ok) return;
    props.onDone(
      result.status === 200 && result.body.state === "succeeded"
        ? `The ${target.kind} ${target.name} is active again. Revoked credentials stay revoked.`
        : `The reactivation of the ${target.kind} ${target.name} is not finished. Operation ${result.body.operationId}.`,
    );
  };

  return (
    <ConfirmDialog
      title={`Reactivate the ${target.kind} ${target.name}`}
      name={target.name}
      confirm="Reactivate"
      busy={action.busy || action.held}
      onConfirm={() => void reactivate()}
      onCancel={props.onCancel}
    >
      <p>{ACTIONS.reactivate[target.kind]}</p>
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action={`reactivate the ${target.kind}`} />
      )}
    </ConfirmDialog>
  );
}
