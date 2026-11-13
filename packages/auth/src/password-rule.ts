// The password rule (P-46) lives in @mykey/contracts, so the API's request
// schemas and the product code check one rule; re-exported here.
export {
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
  checkPassword,
  type PasswordCheck,
} from "@mykey/contracts";
