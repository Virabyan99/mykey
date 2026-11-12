# runtime: the API process inside org-<id>. Reads and writes the KV data of every
# environment of the organization; a soft delete always names its version, so
# no path grants the delete capability (P-23).
path "kv/data/p/*"            { capabilities = ["create", "update", "read"] }
path "kv/metadata/p/*"        { capabilities = ["read", "list"] }
path "kv/delete/p/*"          { capabilities = ["update"] }
path "kv/undelete/p/*"        { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
