# provisioner: writes the per-environment machine policy and token role of org-<id>.
path "sys/policies/acl/machine-env-*"  { capabilities = ["create", "update", "read"] }
path "auth/token/roles/machine-env-*"  { capabilities = ["create", "update", "read"] }
path "auth/token/revoke-self"          { capabilities = ["update"] }
