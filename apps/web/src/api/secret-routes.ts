// The requests whose body or answer carries a secret (P-138, D-60): a value,
// a token, a password, a key or recovery codes. None of them goes through the
// query cache, which would keep the answer for as long as the cache lives.
// The contract's routes are sent by `callSecret`, the auth paths by the
// functions of auth.ts; tests/unit/web/sources.test.ts fails when one is
// named inside a query.
export const SECRET_BEARING = Object.freeze([
  "secrets.reveal",
  "secrets.create",
  "secrets.update",
  "import.preview",
  "import.apply",
  "import.resume",
  "export.create",
  "credentials.issue",
  "auth.reset.complete",
  "/v1/auth/totp/enroll",
  "/v1/auth/totp/activate",
  "/v1/auth/recovery/regenerate",
  "/v1/auth/change-password",
  "/v1/auth/sign-in/email",
] as const);

export type SecretBearing = (typeof SECRET_BEARING)[number];
