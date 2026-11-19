// Where an answer that names an operation leads (P-140): to the operations
// of its environment, where the operation's state can be read. It is a link
// and nothing more: no button beside an unknown outcome sends the change again.
import { webPath } from "@mykey/contracts";
import type { Failure } from "../errors/explain.ts";
import { Link } from "../router.tsx";

export function OperationsLink(props: {
  failure: Failure | null;
  at: Readonly<Record<"org" | "project" | "env", string>>;
}) {
  const { failure } = props;
  if (failure?.kind !== "api" || failure.operationId === null) return null;
  return <Link to={webPath("operations", props.at)}>Operations of this environment</Link>;
}
