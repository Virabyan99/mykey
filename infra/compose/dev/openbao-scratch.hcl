# Run 6.5: the scratch OpenBao of scratch-bao.override.yml. As openbao.hcl,
# without the audit stanza: a restored snapshot brings the stack's device.
ui            = false
disable_mlock = true
api_addr      = "https://openbao:8200"
cluster_addr  = "https://openbao:8201"

storage "raft" {
  path    = "/openbao/file"
  node_id = "dev-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file   = "/pki/openbao.crt"
  tls_key_file    = "/pki/openbao.key"
}

seal "static" {
  current_key_id = "dev-1"
  current_key    = "file:///pki/openbao-static-seal.key"
}
