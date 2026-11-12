// organizations.list (Run 3.7): the caller's active memberships, with role and
// the organization's state, so the owner sees a provisioning or a review.
// No namespace and no digest leave the API.
import { listOrganizations } from "@mykey/db";
import { ApiError, type Handler } from "../pipeline/context.ts";

export const organizationsListHandler: Handler = async (ctx, deps) => {
  const principal = ctx.principal;
  if (principal === null) throw new ApiError("unauthenticated");
  const organizations = await listOrganizations(deps.pool, principal.userId);
  return { status: 200, body: { organizations } };
};
