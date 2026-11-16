// The API's OpenBao identities (Run 4.2, P-62, D-34; Run 5.1, P-85, D-40).
// `runtime`: the organization's runtime AppRole with inline authentication on
// every request. `issuer`: one login per issuance, revocation or archive step,
// revoked at the end of that step. The API serves the one organization whose
// credentials it was given.
import type { OrganizationId } from "@mykey/contracts";
import type { BaoResult, OpenBaoClient } from "@mykey/openbao";

export interface RuntimeBao {
  /** A client for the organization's namespace; null when this process holds no credential for it. */
  clientFor(organizationId: OrganizationId): OpenBaoClient | null;
  /** The organization this process serves; null before its files exist. */
  organizationId(): OrganizationId | null;
  /**
   * A client of the organization's namespace that authenticates with a
   * presented token (Run 5.4); null when this process does not serve it. Used
   * for one request and dropped.
   */
  withToken(organizationId: OrganizationId, token: string): OpenBaoClient | null;
}

export interface IssuerSession {
  client: OpenBaoClient;
  /** tokenRevokeSelf; never throws. A failed revoke-self leaves a token that dies within 60 s. */
  close(): Promise<void>;
}

export interface IssuerBao {
  /** null: this process holds no issuer credential for it. */
  open(organizationId: OrganizationId): Promise<BaoResult<IssuerSession> | null>;
}
