# OpenBao Agent in process-supervisor mode (Run 2.8). run.sh fills the
# placeholders: __PREFIX__ (p/<project>/e/<environment>), __ENV_TEMPLATES__
# (one env_template block per secret name) and __CHILD_MODE__.
pid_file = "/tmp/agent.pid"

vault {
  address = "https://openbao:8200"
  ca_cert = "/run/spike/ca.crt"
}

auto_auth {
  method "token_file" {
    config {
      token_file_path = "/run/spike/token"
    }
  }
}

template_config {
  static_secret_render_interval = "3s"
}

__ENV_TEMPLATES__

exec {
  command                   = ["/bin/sh", "/spike/child.sh", "__CHILD_MODE__"]
  restart_on_secret_changes = "always"
}
