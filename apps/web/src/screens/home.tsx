// The entry path. One organization: straight to it. Several: the list. None:
// said plainly (Stage 1 has no way to create one from the workspace).
import { webPath } from "@mykey/contracts";
import { useEffect } from "react";
import { Link, navigate } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { StateBadge } from "../ui/StateBadge.tsx";

export function Home() {
  const { organizations } = useScope();
  const only = organizations.length === 1 ? organizations[0] : undefined;
  useEffect(() => {
    if (only !== undefined) navigate(webPath("overview", { org: only.id }), { replace: true });
  }, [only]);
  if (only !== undefined) return null;
  return (
    <>
      <h1>Organizations</h1>
      {organizations.length === 0 ? (
        <p>
          This account is not a member of any organization. An operator creates an organization from
          the host (runbook provisioning.md).
        </p>
      ) : (
        <ul className="rows">
          {organizations.map((row) => (
            <li key={row.id}>
              <Link to={webPath("overview", { org: row.id })}>{row.id}</Link> · {row.role} ·{" "}
              <StateBadge kind="organization" state={row.state} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
