# machine-env-{{eid}}: a machine token reads the current secrets of one environment.
path "kv/data/p/{{pid}}/e/{{eid}}/*"    { capabilities = ["read"] }
path "kv/metadata/p/{{pid}}/e/{{eid}}/" { capabilities = ["list"] }
path "auth/token/lookup-self"           { capabilities = ["read"] }
