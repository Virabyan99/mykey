# backup: root namespace only. Takes a Raft snapshot and nothing else.
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
