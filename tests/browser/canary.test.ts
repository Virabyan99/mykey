// Run 7.10 (Doc 10 §4.1 rules 2 and 6; FR-1.23, FR-1.76; D-59): the owner's
// journey with a canary as every secret: the reset token, the password, the
// setup key, the recovery codes, every code typed, every secret value and the
// machine token. Afterwards nothing the browser keeps holds any of them: not
// while the owner is still signed in, not after the sign-out, and not in any
// entry of the history.
//
// A canary is assembled at run time and never printed: a finding names what
// was found and where, not the value.
import { randomBytes } from "node:crypto";
import { createThrottle } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticator,
  heading,
  journeyValues,
  ownerJourney,
  signInByForm,
  signOutByButton,
} from "../harness/journey.ts";
import { pgDump, readAuditLog } from "../harness/stack.ts";
import { startWebWithStores, type StoresWeb, type WebSession } from "../harness/web.ts";

let web: StoresWeb;
let provisioner: Awaited<ReturnType<StoresWeb["f"]["fx"]["start"]>> | null = null;

beforeAll(async () => {
  web = await startWebWithStores();
  provisioner = await web.f.fx.start();
}, 600_000);

afterAll(async () => {
  await provisioner?.stop();
  await web.close();
});

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

interface Needle {
  what: string;
  value: string;
  /** A short code of digits: it counts only as a whole word, not inside an id. */
  word?: boolean;
}

/** Every place the browser keeps something, as text. */
type Places = Record<string, string>;

/** What the page itself can reach: read inside the page. */
const IN_PAGE = `(async () => {
  const entries = (store) => JSON.stringify(Object.entries(store));
  const text = (value) => {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const asked = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const databases = [];
  for (const info of await indexedDB.databases()) {
    databases.push(String(info.name));
    const database = await asked(indexedDB.open(info.name));
    for (const name of [...database.objectStoreNames]) {
      const store = database.transaction(name, "readonly").objectStore(name);
      databases.push(name, text(await asked(store.getAllKeys())), text(await asked(store.getAll())));
    }
    database.close();
  }
  const cached = [];
  for (const name of await caches.keys()) {
    cached.push(name);
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      cached.push(request.url, response === undefined ? "" : await response.text());
    }
  }
  const fields = [...document.querySelectorAll("input, textarea, select")].map((field) => field.value);
  return {
    "localStorage": entries(localStorage),
    "sessionStorage": entries(sessionStorage),
    "IndexedDB": databases.join("\\n"),
    "Cache Storage": cached.join("\\n"),
    "document.cookie": document.cookie,
    "history.state": text(history.state),
    "the address": location.href,
    "the document": document.documentElement.outerHTML + "\\n" + fields.join("\\n"),
  };
})()`;

interface Watch {
  session: WebSession;
  /** Console lines and uncaught errors of the page. */
  said: string[];
  /** Every address a frame showed, from the moment the watch began. */
  shown: string[];
}

/** A move in the history may load a document: wait until it is there and has drawn. */
async function settled(watch: Watch): Promise<void> {
  await watch.session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await watch.session.page.waitForTimeout(400);
}

async function places(watch: Watch): Promise<Places> {
  let inPage: Places | null = null;
  for (let attempt = 0; inPage === null; attempt += 1) {
    try {
      inPage = await watch.session.page.evaluate<Places>(IN_PAGE);
    } catch (error) {
      // The document was replaced while it was read: read the new one.
      if (attempt === 4) throw error;
      await settled(watch);
    }
  }
  const cookies = await watch.session.context.cookies();
  return {
    ...inPage,
    "the cookies": cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n"),
    "the console": watch.said.join("\n"),
    "a requested address": watch.session.requested.join("\n"),
    "a shown address": watch.shown.join("\n"),
  };
}

/** "<what> in <place>" for every needle a place holds. Never the value. */
function found(where: Places, needles: readonly Needle[]): string[] {
  const hits: string[] = [];
  for (const [place, text] of Object.entries(where)) {
    for (const needle of needles) {
      const hit =
        needle.word === true
          ? new RegExp(`(?<![0-9A-Za-z])${needle.value}(?![0-9A-Za-z])`).test(text)
          : text.includes(needle.value) || text.includes(encodeURIComponent(needle.value));
      if (hit) hits.push(`${needle.what} in ${place}`);
    }
  }
  return hits;
}

/**
 * Searches where the page is, then every earlier entry of the history, and
 * comes back. Returns the findings and how many entries were searched.
 */
async function search(
  watch: Watch,
  needles: readonly Needle[],
): Promise<{ hits: string[]; entries: number }> {
  const { page } = watch.session;
  const hits = new Set(found(await places(watch), needles));
  const length = Number(await page.evaluate("history.length"));
  let back = 0;
  while (back < Math.min(length - 1, 80)) {
    await page.goBack({ waitUntil: "commit" }).catch(() => null);
    await settled(watch);
    // The entry before the first address is the browser's empty page.
    if (!page.url().startsWith(web.origin)) {
      await page.goForward({ waitUntil: "commit" }).catch(() => null);
      await settled(watch);
      break;
    }
    back += 1;
    for (const hit of found(await places(watch), needles)) hits.add(`${hit} (history entry)`);
  }
  for (let forward = 0; forward < back; forward += 1) {
    await page.goForward({ waitUntil: "commit" }).catch(() => null);
    await settled(watch);
  }
  return { hits: [...hits].sort(), entries: back + 1 };
}

describe("the canary scan", () => {
  it("after the whole journey, and again after the sign-out, no storage, cookie, address, history entry, document or console line holds a secret; a control canary is found by the same search", async () => {
    const account = web.tenants.credentials("ownerA");
    const userId = web.tenants.userId("ownerA");
    const db = web.api.superuser;
    await db.query("DELETE FROM app.rate_limit");
    const needles: Needle[] = [];

    // An operator's reset link for the owner: a new password and a new authenticator.
    const pool = web.api.database.pool("maintenance");
    const issued = await initiateReset(
      {
        pool,
        keys: web.api.keys,
        throttle: createThrottle({ pool, ring: web.api.keys.rateLimit }),
      },
      { email: account.email, kind: "mfa" },
    );
    if (issued.outcome !== "issued") throw new Error(`reset ${issued.outcome}`);
    needles.push({ what: "the reset token", value: issued.token });
    const password = canary();
    needles.push({ what: "the password", value: password });

    const session = await web.anonymous();
    const { page } = session;
    const watch: Watch = { session, said: [], shown: [] };
    page.on("console", (message) => watch.said.push(message.text()));
    page.on("pageerror", (error) => watch.said.push(String(error)));
    try {
      // --- the reset link, the new password, the new authenticator ----------
      await page.goto(`${web.origin}/reset#t=${issued.token}&k=mfa`);
      await heading(page, "Reset your account").waitFor();
      await page.getByLabel("New password", { exact: true }).waitFor();
      expect(page.url()).toBe(`${web.origin}/reset`);
      // From here on every address shown is kept (the link itself is the owner's paste).
      page.on("framenavigated", (frame) => watch.shown.push(frame.url()));
      await page.getByLabel("New password", { exact: true }).fill(password);
      await page.getByLabel("New password again").fill(password);
      await page.getByRole("button", { name: "Set the new password" }).click();
      await heading(page, "Set up your authenticator").waitFor();
      await page.getByRole("button", { name: "Create a setup key" }).click();
      const shownKey = ((await page.getByLabel("Setup key").textContent()) ?? "").trim();
      const key = shownKey.replaceAll(/\s/g, "");
      needles.push(
        { what: "the setup key", value: key },
        { what: "the setup key as shown", value: shownKey },
      );
      const codes = authenticator(new Uint8Array(OTPAuth.Secret.fromBase32(key).bytes));
      await page.getByLabel("Code from your authenticator app").fill(await codes.next());
      await page.getByRole("button", { name: "Activate" }).click();
      const list = page.getByRole("list", { name: "Recovery codes" });
      await list.waitFor();
      const recovery = (await list.getByRole("listitem").allTextContents()).map((code) =>
        code.trim(),
      );
      expect(recovery).toHaveLength(10);
      recovery.forEach((code, index) =>
        needles.push({ what: `recovery code ${String(index + 1)}`, value: code }),
      );
      await page.getByRole("button", { name: "I saved them" }).click();

      // --- the end of a reset is a new sign-in (P-51): the form, the new password
      // The page says why the sign-in form is back.
      await page
        .getByRole("status")
        .filter({ hasText: "The new authenticator is active. Sign in with your new password" })
        .waitFor();
      await signInByForm(page, { email: account.email, password }, codes.next);

      // --- the journey, every value a canary --------------------------------
      const values = journeyValues(canary, { userId, code: codes.next });
      const facts = await ownerJourney(web, page, values);
      for (const entry of [...values.secrets, ...values.imported]) {
        needles.push({ what: `the value of ${entry.name}`, value: entry.value });
      }
      needles.push(
        { what: "the edited value", value: values.edited },
        { what: "the machine token", value: facts.token },
      );
      codes.used.forEach((code, index) =>
        needles.push({ what: `authenticator code ${String(index + 1)}`, value: code, word: true }),
      );
      // The search has something to look for: the token, the password, the key in two
      // forms, ten recovery codes, six values, the machine token and two codes at least.
      expect(new Set(needles.map((needle) => needle.value)).size).toBeGreaterThanOrEqual(23);
      for (const needle of needles) expect(needle.value.length, needle.what).toBeGreaterThan(5);

      // Run 8.4: the session cookie the browser holds now; a needle for the server's side
      // only (the browser keeps it by design until the sign-out).
      const held = (await session.context.cookies()).find((cookie) =>
        cookie.name.endsWith("better-auth.session_token"),
      );
      if (held === undefined) throw new Error("no session cookie in the browser");
      const cookieValue = decodeURIComponent(held.value);
      const sessionNeedles: Needle[] = [
        { what: "the session cookie", value: cookieValue },
        { what: "the session token", value: cookieValue.slice(0, cookieValue.lastIndexOf(".")) },
      ];

      // --- still signed in --------------------------------------------------
      const open = await search(watch, needles);
      expect(open.hits).toEqual([]);
      expect(open.entries).toBeGreaterThan(8);

      // --- after the sign-out -----------------------------------------------
      await signOutByButton(page);
      const closed = await search(watch, needles);
      expect(closed.hits).toEqual([]);
      expect(closed.entries).toBeGreaterThan(8);

      // --- Run 8.4: the same needles on the server's side, each place with a control
      const secretName = values.secrets[0].name;
      const server: Places = {
        "the database dump": await pgDump(web.f.stack, web.api.database.database),
        "the API's log lines": web.api.logs.map((entry) => JSON.stringify(entry)).join("\n"),
        "the provisioner's log lines": (provisioner?.logs ?? [])
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
        "OpenBao's audit device": (await readAuditLog(web.f.stack))
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      };
      const controls: Record<string, string> = {
        "the database dump": secretName,
        "the API's log lines": '"event":"request"',
        "the provisioner's log lines": '"event":"job"',
        "OpenBao's audit device": secretName,
      };
      expect(secretName.length).toBeGreaterThan(5);
      for (const [place, control] of Object.entries(controls)) {
        expect(server[place]?.includes(control), `the control in ${place}`).toBe(true);
      }
      expect(found(server, [...needles, ...sessionNeedles])).toEqual([]);

      // --- control: the same search finds a canary put into each place ------
      const control = canary();
      await page.evaluate(`(async () => {
        const control = ${JSON.stringify(control)};
        localStorage.setItem("control", control);
        sessionStorage.setItem("control", control);
        await new Promise((resolve, reject) => {
          const opening = indexedDB.open("control", 1);
          opening.onupgradeneeded = () => opening.result.createObjectStore("kept");
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const writing = opening.result.transaction("kept", "readwrite");
            writing.objectStore("kept").put({ control }, "one");
            writing.oncomplete = () => {
              opening.result.close();
              resolve(undefined);
            };
            writing.onerror = () => reject(writing.error);
          };
        });
        const cache = await caches.open("control");
        await cache.put("/control-entry", new Response(control));
        document.cookie = "control=" + control + "; path=/; secure";
        history.replaceState({ control }, "", location.pathname + "?control=" + control);
        const node = document.createElement("p");
        node.textContent = control;
        document.body.appendChild(node);
        console.log(control);
        await fetch("/v1/organizations?control=" + control).catch(() => undefined);
      })()`);
      await page.waitForTimeout(300);
      const seen = found(await places(watch), [{ what: "the control", value: control }]);
      expect(seen.sort()).toEqual(
        [
          "Cache Storage",
          "IndexedDB",
          "a requested address",
          "a shown address",
          "document.cookie",
          "history.state",
          "localStorage",
          "sessionStorage",
          "the address",
          "the console",
          "the cookies",
          "the document",
        ].map((place) => `the control in ${place}`),
      );
      // A code is found as a word, and not inside an id.
      const digits = [{ what: "a code", value: "123456", word: true }];
      expect(found({ here: '{"code":"123456"}' }, digits)).toEqual(["a code in here"]);
      expect(found({ here: "a1234567-0123456b" }, digits)).toEqual([]);

      expect(session.thirdParty).toEqual([]);
    } finally {
      await session.close();
    }
  }, 900_000);
});
