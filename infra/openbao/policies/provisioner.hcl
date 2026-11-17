# provisioner: writes the per-environment machine policy and token role of org-<id>,
# and reads (never writes) the organization objects its drift sweep compares (Run 3.8).
path "sys/policies/acl/machine-env-*"  { capabilities = ["create", "update", "read"] }
path "auth/token/roles/machine-env-*"  { capabilities = ["create", "update", "read"] }
path "sys/policies/acl/runtime"        { capabilities = ["read"] }
path "sys/policies/acl/issuer"         { capabilities = ["read"] }
path "sys/policies/acl/provisioner"    { capabilities = ["read"] }
path "sys/mounts/kv"                   { capabilities = ["read"] }
path "kv/config"                       { capabilities = ["read"] }
path "auth/token/revoke-self"          { capabilities = ["update"] }
# Run 6.7 (P-122): the backend incarnation it compares before every job.
path "mykey-meta/data/incarnation"    { capabilities = ["read"] }
