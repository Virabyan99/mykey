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
// Run 5.2: an environment's machine credentials settled from the backend (P-90).
export {
  reconcileCredentials,
  type CredentialReconcileDeps,
  type CredentialReconciliation,
} from "./reconcile/credentials.ts";
// Run 6.5 (P-118, P-120): the capture coordinator (maintenance; `ops capture`).
export {
  CANDIDATE_DEADLINE_SECONDS,
  DRAIN_DEADLINE_MS,
  FROZEN_DEADLINE_MS,
  abortCapture,
  beginCapture,
  recordCapture,
  settlePair,
  type BeginResult,
  type Boundary,
  type CaptureRecord,
  type Publication,
  type Settled,
} from "./capture/coordinator.ts";
// Run 6.6 (P-121): retention applies planRetention's plan (`ops pair --step retention`).
export { applyRetention, type CleanupResult } from "./capture/retention.ts";
