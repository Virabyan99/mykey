// Run 2.7: the OpenBao server configuration of a host, rendered from its template.
import { describe, expect, it } from "vitest";
import { renderOpenBaoConfig } from "../../../scripts/host.ts";

const rendered = renderOpenBaoConfig({
  host: "staging",
  kmsHost: "us-east-vin.okms.ovh.us",
  sealKeyId: "00000000-1111-4222-8333-444444444444",
  maxRequestDuration: "15s",
});

const blocks = (kind: string): string[] =>
  rendered.match(new RegExp(`^${kind} "[^"]+"`, "gm")) ?? [];

describe("openbao.hcl", () => {
  it("has exactly one seal, of type kmip, and never the static seal", () => {
    expect(blocks("seal")).toEqual(['seal "kmip"']);
    expect(rendered).not.toContain("static");
  });

  it("points the seal at the region's KMIP endpoint with the host's certificate and verified TLS", () => {
    expect(rendered).toContain('endpoint    = "us-east-vin.okms.ovh.us:5696"');
    expect(rendered).toContain('server_name = "us-east-vin.okms.ovh.us"');
    expect(rendered).toContain('kms_key_id  = "00000000-1111-4222-8333-444444444444"');
    expect(rendered).toContain('client_cert = "/openbao/kms/seal.crt"');
    expect(rendered).toContain('client_key  = "/openbao/kms/seal.key"');
    expect(rendered).not.toMatch(/tls_skip_verify|insecure/);
  });

  it("listens with TLS 1.3 and bounded read times (D-20), and caps request duration", () => {
    expect(rendered).toContain('tls_min_version          = "tls13"');
    expect(rendered).toContain('http_read_header_timeout = "10s"');
    expect(rendered).toContain('http_read_timeout        = "30s"');
    expect(rendered).toContain('default_max_request_duration = "15s"');
  });

  it("stores in Raft under the host's node id and keeps the audit device", () => {
    expect(rendered).toContain('node_id = "staging"');
    expect(blocks("audit")).toEqual(['audit "file"']);
    expect(rendered).toContain('file_path = "/openbao/audit/audit.log"');
  });

  it("leaves no placeholder and refuses a value that could break out of a string", () => {
    expect(rendered).not.toMatch(/\{\{|\}\}/);
    expect(() =>
      renderOpenBaoConfig({
        host: "staging",
        kmsHost: 'x"; y',
        sealKeyId: "k",
        maxRequestDuration: "15s",
      }),
    ).toThrow();
    expect(() =>
      renderOpenBaoConfig({
        host: "staging",
        kmsHost: "a.b",
        sealKeyId: "k",
        maxRequestDuration: "forever",
      }),
    ).toThrow();
  });
});
