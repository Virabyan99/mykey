// Refuses to start the cloud tests without their credentials, so a missing
// token is a failure and never a silent skip. Run: node scripts/require-cloud-env.ts
import { loadR2Credentials, type CredentialSource } from "../infra/backup/retention-fixture/r2.ts";

/** The R2 tokens the cloud tests use. */
export const REQUIRED_CLOUD_TOKENS = [
  "mykey-fixture-upload",
  "mykey-fixture-cleanup",
  "mykey-r2-admin",
];

/** The required tokens whose credentials cannot be loaded. */
export function missingCloudCredentials(source: CredentialSource = {}): string[] {
  return REQUIRED_CLOUD_TOKENS.filter((token) => {
    try {
      loadR2Credentials(token, source);
      return false;
    } catch {
      return true;
    }
  });
}

if (import.meta.main) {
  const missing = missingCloudCredentials();
  if (missing.length > 0) {
    console.error(`cloud credentials missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("cloud credentials present.");
}
