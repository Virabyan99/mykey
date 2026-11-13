// @mykey/operations/operator — the operator's organization provisioning (Run 3.8).
// It holds OpenBao operator authority: only apps/ops and tests import it; the API
// and the provisioner never do (tests/unit/skeleton).
export {
  ORGANIZATION_POINTS,
  ORGANIZATION_STEPS,
  provisionOrganization,
  verifyOrganization,
  type OrganizationStep,
  type ProvisionDeps,
  type ProvisionResult,
  type StepOutcome,
} from "./provisioning/organization.ts";
