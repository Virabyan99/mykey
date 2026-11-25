// What a browser keeps, as text (Run 7.10's canary scan; a harness module since
// Run 11.6, so that every test that shows a secret can search the same places):
// both storages, IndexedDB, Cache Storage, the cookies, the history state, the
// address and the document with what its fields hold. A finding names the
// place, never the value.
import type { WebSession } from "./web.ts";

/** Every place the browser keeps something, as text. */
export type Places = Record<string, string>;

/** What the page itself can reach: read inside the page. */
export const IN_PAGE = `(async () => {
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

/** Everything the session keeps where the page is now, and every address it asked for. */
export async function keptBy(session: WebSession): Promise<Places> {
  const inPage = await session.page.evaluate<Places>(IN_PAGE);
  const cookies = await session.context.cookies();
  return {
    ...inPage,
    "the cookies": cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n"),
    "a requested address": session.requested.join("\n"),
  };
}

/** The places that hold `value`, as it is or encoded for an address. Never the value. */
export function holders(where: Places, value: string): string[] {
  return Object.entries(where)
    .filter(([, text]) => text.includes(value) || text.includes(encodeURIComponent(value)))
    .map(([place]) => place)
    .sort();
}
