// The API's OpenBao identity (Run 4.2, P-62, D-34): the organization's
// `runtime` AppRole with inline authentication on every request. The API
// serves the one organization whose credential it was given.
import type { OrganizationId } from "@mykey/contracts";
import type { OpenBaoClient } from "@mykey/openbao";

export interface RuntimeBao {
  /** A client for the organization's namespace; null when this process holds no credential for it. */
  clientFor(organizationId: OrganizationId): OpenBaoClient | null;
}
