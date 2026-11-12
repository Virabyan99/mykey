# issuer: mints, looks up and revokes machine tokens of org-<id> through the
# machine-env-* token roles. It can read those roles and policies, never write them.
path "auth/token/create/machine-env-*" { capabilities = ["update"] }
path "auth/token/roles/machine-env-*"  { capabilities = ["read"] }
path "sys/policies/acl/machine-env-*"  { capabilities = ["read"] }
path "auth/token/lookup-accessor"      { capabilities = ["update"] }
path "auth/token/revoke-accessor"      { capabilities = ["update"] }
path "auth/token/revoke-self"          { capabilities = ["update"] }
