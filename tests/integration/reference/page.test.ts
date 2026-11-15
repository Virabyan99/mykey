// Run 5.9 Task B (P-101, FR-1.52, FR-1.53): GET /v1/reference is one HTML
// document that needs nothing else: Scalar's standalone script from the pinned
// package inline, the served OpenAPI document as a data block, and a policy
// that lets the page run those two inline scripts and make no request at all.
// Owner and admin of the process's organization get it; everyone else gets the
// hidden 404. A process without the asset answers 503 and says so once.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyReferenceAsset } from "../../../scripts/reference-asset.ts";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let bare: TestApi;
let tenants: Tenants;
let bareTenants: Tenants;
let scalarVersion: string;
const cookies = new Map<FixtureUser, string>();

beforeAll(async () => {
  // The asset as `pnpm run reference:asset` makes it, into the default place.
  ({ version: scalarVersion } = copyReferenceAsset());
  api = await startTestApi({
    dispatcher: false,
    processOrganization: () => tenants.a.organizationId,
  });
  tenants = await createTenants(api);
  for (const user of ["ownerA", "adminA", "editorA", "readerA", "envEditorA", "ownerB"] as const) {
    cookies.set(user, await tenants.cookie(user));
  }
  bare = await startTestApi({
    dispatcher: false,
    processOrganization: () => bareTenants.a.organizationId,
    config: { referenceAssetDirectory: mkdtempSync(join(tmpdir(), "mykey-no-asset-")) },
  });
  bareTenants = await createTenants(bare);
}, 300_000);

afterAll(async () => {
  await bare.close();
  await api.close();
});

async function page(user: FixtureUser = "ownerA", on: TestApi = api) {
  const cookie = on === api ? cookies.get(user)! : await bareTenants.cookie(user);
  const response = await on.request("GET", "/v1/reference", { cookie });
  return { response, text: await response.text() };
}

interface Parsed {
  /** Executable inline scripts, their text exactly as served. */
  scripts: string[];
  /** The text of `<script type="application/json" id="openapi-document">`. */
  data: string | null;
  /** The markup with every script element's text removed. */
  markup: string;
}

function parse(html: string): Parsed {
  const scripts: string[] = [];
  let data: string | null = null;
  const markup = html.replace(
    /<script([^>]*)>([\s\S]*?)<\/script>/gi,
    (_all, attrs: string, body: string) => {
      if (attrs.includes('type="application/json"')) {
        expect(attrs).toContain('id="openapi-document"');
        data = body;
      } else {
        scripts.push(body);
      }
      return `<script${attrs}></script>`;
    },
  );
  return { scripts, data, markup };
}

/** The error code of a JSON error envelope. */
const codeOf = (text: string): string =>
  (JSON.parse(text) as { error: { code: string } }).error.code;

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("GET /v1/reference", () => {
  it("answers one HTML document with the headers of P-101, exactly", async () => {
    const { response, text } = await page();
    expect(response.status).toBe(200);
    const { scripts } = parse(text);
    expect(scripts).toHaveLength(2);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(
      [
        "default-src 'none'",
        `script-src ${scripts.map(sha256).join(" ")}`,
        "style-src 'unsafe-inline'",
        "img-src data:",
        "connect-src 'none'",
        "font-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
  });

  it("both inline scripts are intact JavaScript after escaping, and nothing can close them early", () => {
    return page().then(({ text }) => {
      const { scripts } = parse(text);
      for (const script of scripts) {
        expect(script).not.toMatch(/<\/script|<!--|<script/i);
        expect(() => new Script(script)).not.toThrow();
      }
      // The first is Scalar's own build, the second starts it on the data block.
      expect(scripts[0]!.length).toBeGreaterThan(1_000_000);
      expect(scripts[1]).toContain("openapi-document");
    });
  });

  it("its own markup names no other origin: no src, href, action or url(", async () => {
    const { markup } = parse((await page()).text);
    expect(markup).not.toMatch(/\ssrc\s*=|\shref\s*=|\saction\s*=|url\(/i);
    expect(markup).toContain('<div id="app"></div>');
  });

  it("the data block parses to the served document", async () => {
    const { data } = parse((await page()).text);
    expect(data).not.toBeNull();
    expect(data).not.toContain("<");
    const served = await api.request("GET", "/v1/openapi.json", { cookie: cookies.get("ownerA")! });
    expect(JSON.parse(data!)).toEqual(await served.json());
  });

  it("names the pinned package and its version in a meta tag", async () => {
    const { markup } = parse((await page()).text);
    expect(scalarVersion).toBe("1.77.0");
    expect(markup).toContain(
      `<meta name="generator" content="@scalar/api-reference ${scalarVersion}">`,
    );
  });

  it("owner and admin get it; members and another organization's owner get the 404 of an unknown path", async () => {
    expect((await page("adminA")).response.status).toBe(200);
    const unknown = await api.request("GET", "/v1/no-such-route", {
      cookie: cookies.get("ownerA")!,
    });
    expect(unknown.status).toBe(404);
    const absent = codeOf(await unknown.text());
    expect(absent).toBe("not_found");
    for (const user of ["editorA", "readerA", "envEditorA", "ownerB"] as const) {
      const { response, text } = await page(user);
      expect(response.status, user).toBe(404);
      expect(codeOf(text), user).toBe(absent);
    }
    const anonymous = await api.request("GET", "/v1/reference", {});
    expect(anonymous.status).toBe(401);
  });

  it("without the asset file: 503, and one reference_asset_missing entry at start", async () => {
    for (let i = 0; i < 2; i++) {
      const { response, text } = await page("ownerA", bare);
      expect(response.status).toBe(503);
      expect(codeOf(text)).toBe("dependency_unavailable");
    }
    expect(bare.logs.filter((entry) => entry.event === "reference_asset_missing")).toHaveLength(1);
    expect(api.logs.filter((entry) => entry.event === "reference_asset_missing")).toHaveLength(0);
  });
});
