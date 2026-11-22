// Run 9.0 (the owner's journey on staging, 22 Nov 2026): a browser on
// https://127.0.0.1:<port> is refused by the API's origin check (the page's
// origin is not MYKEY_BASE_URL's) and warned off by the listener's own CA. The
// browser window of `tunnel verify --browser` reaches the host's own name
// through the tunnel instead, and trusts only that listener's key.
import { describe, expect, it } from "vitest";
import { parseHostArgs, verifyBrowserArgs } from "../../../scripts/host.ts";

describe("tunnel verify --browser", () => {
  it("parses with and without --browser, and refuses anything else", () => {
    expect(parseHostArgs(["staging", "tunnel", "verify"])).toMatchObject({
      command: "tunnel",
      target: "verify",
      browser: false,
    });
    expect(parseHostArgs(["prod", "tunnel", "verify", "--browser"])).toMatchObject({
      command: "tunnel",
      target: "verify",
      browser: true,
    });
    expect(() => parseHostArgs(["prod", "tunnel", "verify", "--other"])).toThrow(/tunnel needs/);
  });

  it("maps the host's own name on 443 to the tunnel, in a profile of its own", () => {
    const argv = verifyBrowserArgs({
      hostname: "mykey.example.invalid",
      localPort: 53652,
      spki: "E19vDMFG8o1M13uZxrksCVfmLYP6zvIL/Ye4g45o79s=",
      profileDir: "C:/tmp/profile",
    });
    expect(argv).toEqual([
      "--user-data-dir=C:/tmp/profile",
      "--host-resolver-rules=MAP mykey.example.invalid:443 127.0.0.1:53652",
      "--ignore-certificate-errors-spki-list=E19vDMFG8o1M13uZxrksCVfmLYP6zvIL/Ye4g45o79s=",
      "--no-first-run",
      "--new-window",
      "https://mykey.example.invalid/",
    ]);
  });

  it("refuses a hostname or key that could carry another flag", () => {
    const base = { localPort: 1, profileDir: "p" };
    expect(() =>
      verifyBrowserArgs({ ...base, hostname: "a.invalid,MAP * 1.2.3.4", spki: "AA==" }),
    ).toThrow(/hostname/);
    expect(() => verifyBrowserArgs({ ...base, hostname: "a.invalid", spki: "x y" })).toThrow(/key/);
  });
});
