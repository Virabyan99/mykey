// The service gate reader lives in @mykey/operations since Run 3.8: the
// provisioner checks the same record before every job.
export {
  GATE_MAX_BYTES,
  readGate,
  type GateCause,
  type GateIo,
  type GateReading,
  type GateRecord,
} from "@mykey/operations";
