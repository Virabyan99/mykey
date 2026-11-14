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
// Run 4.5: reconciliation of operations and environments (operator authority).
export {
  UnknownOperation,
  reconcileOperation,
  type OperationVerdict,
  type ReconcileDeps,
} from "./reconcile/operation.ts";
export {
  RECONCILE_LOCK_WAIT_MS,
  reconcileEnvironment,
  type EnvironmentVerdict,
} from "./reconcile/environment.ts";
export { BackendUnreadable, rebuildKey } from "./reconcile/rebuild.ts";
