// Run 6.5 (P-118, D-51): the barrier's SQLSTATE and its test, for the API,
// the provisioner and the operations engine. The repository lives in @mykey/db
// so that @mykey/auth can use it too.
export { CAPTURE_SQLSTATE, isCaptureRefusal } from "@mykey/db";
