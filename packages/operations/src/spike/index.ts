// THROW-AWAY (Run 2.4, G-EFFECT spike): not part of the product. Run 4.2
// writes the real operation protocol.
export {
  SPIKE_ACTION,
  SPIKE_PRINCIPAL,
  executeWrite,
  finalize,
  freshStateTag,
  scopeKeyOf,
  spikeSecretPath,
  targetOf,
  type Boundary,
  type SpikeDeps,
  type SpikeOutcome,
  type SpikeWrite,
} from "./executor.ts";
export { reconcile, type ReconcileDeps, type ReconcileState } from "./reconcile.ts";
export type { RunnerJob } from "./runner.ts";
