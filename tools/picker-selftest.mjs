// ─── Does the picker show page 1 without waiting on the whole library? ───────
//
// Johnny, 2026-09-18: "20 thumbnails per page, not 10. Build and show page 1
// first. Do not scan the whole library before those 20 appear. Later pages
// load when I go to them. Stop when the picker opens with 20 on page 1 without
// waiting on the rest of the cache."
//
// Two waits stood between him and page 1:
//   - at world load, with the startup rescan on, the index stayed EMPTY until
//     every one of his folders had been read, while a saved index of the whole
//     library sat unread in the world folder;
//   - the picker searched all ~26,000 entries before drawing anything.
//
// ⚠️ HIS OWN SAVED INDEX, NOT A MADE-UP ONE. The index below is loaded from
// worlds/hijinx/ace-token-art/index-cache.json through the engine's own cache
// path, so the counts and the order are his.
//
// Run:  node tools/picker-selftest.mjs
import { readFileSync, existsSync } from "node:fs";

const CACHE = "D:/FoundryVTT/Data/worlds/hijinx/ace-token-art/index-cache.json";
if (!existsSync(CACHE)) {
  console.log("(no saved token-art index on this machine; nothing was checked)");
  process.exit(0);
}
const cacheJson = JSON.parse(readFileSync(CACHE, "utf8"));
const FOLDERS = cacheJson.folders;

// ── Enough of Foundry and the browser for the engine and the picker ─────────
const hookLog = [];
const hooks = new Map();
let hookId = 0;
globalThis.Hooks = {
  on: (name, fn) => { const id = ++hookId; hooks.set(id, { name, fn }); return id; },
  once: (name, fn) => { const id = ++hookId; hooks.set(id, { name, fn, once: true }); return id; },
  off: (_name, id) => { hooks.delete(id); },
  callAll: (name, ...args) => {
    hookLog.push(name);
    for (const [id, h] of [...hooks]) if (h.name === name) { if (h.once) hooks.delete(id); h.fn(...args); }
  },
};
const SETTINGS = { tokenArtFolders: FOLDERS, tokenArtRescanOnStartup: true, tokenArtPortraitFolders: [], tokenArtProneFolders: [] };
globalThis.game = {
  world: { id: "hijinx" }, user: { isGM: true }, ready: true,
  settings: { get: (_m, k) => SETTINGS[k], register: () => {}, set: async () => {} },
  modules: { get: () => null }, i18n: { localize: (k) => k },
  actors: { get: () => null, find: () => null, [Symbol.iterator]: function* () {} },
};
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { Actor: {}, Token: {} };
globalThis.canvas = { grid: { size: 100 }, tokens: { placeables: [], controlled: [] } };

// The folder walk is held until the test lets it go.
let releaseWalk;
const walkGate = new Promise(r => { releaseWalk = r; });
const FilePicker = {
  browse: async (_src, dir) => {
    if (dir === "worlds/hijinx/ace-token-art") return { files: [`${dir}/index-cache.json`], dirs: [] };
    await walkGate;
    if (FOLDERS.includes(dir)) return { files: [`${dir}/Goblin - Fresh.webp`], dirs: [] };
    return { files: [], dirs: [] };
  },
  upload: async () => ({}), createDirectory: async () => ({}),
};
globalThis.foundry = { utils: { escapeHTML: (s) => String(s) }, applications: { apps: { FilePicker: { implementation: FilePicker } } } };
globalThis.fetch = async () => ({ ok: true, json: async () => cacheJson });
globalThis.performance ??= { now: () => Date.now() };
globalThis.window = { innerWidth: 1600, innerHeight: 900 };

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.dataset = {};
    this._text = ""; this.listeners = {}; this.style = { setProperty(k, v) { this[k] = v; } }; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  set innerHTML(v) { this.children = []; this._html = String(v); }
  get innerHTML() { return this._html ?? ""; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  removeEventListener() {}
  _walk() { return this.children.flatMap(c => [c, ...c._walk()]); }
  querySelectorAll(sel) { return sel === "img[data-ace-src]" ? this._walk().filter(e => e.tagName === "IMG" && e.dataset.aceSrc) : []; }
  querySelector() { return null; }
  contains() { return false; }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}
globalThis.document = { body: new El("body"), createElement: (t) => new El(t),
  addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null };

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(78) + " " + detail);
};

const engine = await import("file:///D:/FoundryVTT/Data/modules/ace-token-art/scripts/token-art-engine.mjs");
const { TokenArtPicker, PER_PAGE, firstMatches } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-token-art/scripts/token-art-picker.mjs");

console.log("\nAT WORLD LOAD, THE SAVED INDEX GOES IN BEFORE THE FOLDERS ARE READ");
const building = engine.activateTokenArtEngine();
for (let i = 0; i < 20 && !engine.getTokenArtIndex().ready; i++) await new Promise(r => setTimeout(r, 5));
const idx = engine.getTokenArtIndex();
check("the saved index is in use while the folder walk is still held", idx.ready && idx.all.length === cacheJson.entries.length,
  `${idx.all.length} entries ready, the walk not yet started`);
check("and it said so, so an open picker can fill in", hookLog.includes(engine.INDEX_READY_HOOK), hookLog.join(", ") || "no hook");

console.log("\nTHE PICKER: 20 PER PAGE, PAGE 1 FIRST");
check("twenty thumbnails per page", PER_PAGE === 20, `PER_PAGE = ${PER_PAGE}`);
{
  const q = "goblin";
  const first = firstMatches(idx, q, PER_PAGE);
  const full = idx.all.filter(e => e.baseLower.includes(q) || e.fullLower.includes(q));
  const lastRead = idx.all.indexOf(first.at(-1));
  check("page 1 is found by reading only as far as the twentieth match",
    first.length === 20 && lastRead < idx.all.length - 1,
    `read ${lastRead + 1} of ${idx.all.length} entries for 20 of ${full.length} goblins`);
  check("and it is the same twenty, in the same order, as the full search",
    first.every((e, i) => e.path === full[i].path), `${first.slice(0, 3).map(e => e.fullName).join(", ")}…`);
}
{
  // The real picker, drawn on a stand-in page. The API's full search is timed.
  let fullSearchAt = null;
  const api = {
    getTokenArtIndex: () => engine.getTokenArtIndex(),
    indexReadyHook: engine.INDEX_READY_HOOK,
    searchTokenArt: (query) => {
      fullSearchAt ??= performance.now();
      const q = String(query ?? "").toLowerCase().trim();
      const all = engine.getTokenArtIndex().all;
      const hits = q ? all.filter(e => e.baseLower.includes(q) || e.fullLower.includes(q)) : all.slice();
      return hits.map(e => ({ base: e.displayBase, variant: e.displayVariant, fullName: e.fullName, path: e.path }));
    },
  };
  game.modules.get = (id) => (id === "ace-token-art" ? { api } : null);
  const tokenDoc = { name: "Goblin", actor: { name: "Goblin" }, update: async () => ({}), texture: { src: "" } };
  const drawnAt = performance.now();
  TokenArtPicker.open(tokenDoc);
  const panel = TokenArtPicker._el?.children?.[0];
  const grid = panel?.children?.[1];
  const footer = panel?.children?.[3];
  const cardsNow = grid?.children?.length ?? 0;
  const loadingNow = (grid?._walk() ?? []).filter(e => e.tagName === "IMG" && e._src === undefined && e.src).length;
  const footerNow = footer?.textContent ?? "";
  check("the picker opens with 20 on page 1, before the full search has run",
    cardsNow === 20 && fullSearchAt === null, `${cardsNow} cards on screen; full search ${fullSearchAt === null ? "not yet run" : "already run"}`);
  check("page 1's pictures start at once, in reading order", loadingNow >= 1 && loadingNow <= 2, `${loadingNow} downloading`);
  check("while the rest is counted", /counting the rest/.test(footerNow), footerNow.slice(0, 60));
  await new Promise(r => setTimeout(r, 5));
  const footerLater = footer?.textContent ?? "";
  check("the full count arrives after, and page 1's cards are not redrawn",
    fullSearchAt !== null && fullSearchAt > drawnAt && grid.children.length === 20 && /\d+ results — showing 1–20/.test(footerLater),
    footerLater.slice(0, 70));
  const pageTwoImgs = (grid?._walk() ?? []).filter(e => e.tagName === "IMG").length;
  check("nothing from page 2 is on the page until he goes there", pageTwoImgs === 20, `${pageTwoImgs} pictures in the grid`);
  TokenArtPicker.close();
}

console.log("\nAND WHEN THE FOLDERS HAVE BEEN READ, THE FRESH INDEX TAKES OVER");
releaseWalk();
await building;
const fresh = engine.getTokenArtIndex();
check("the walk's own index replaces the saved one when it finishes",
  fresh.all.length === FOLDERS.length && fresh.all.every(e => /Goblin - Fresh/.test(e.path)),
  `${fresh.all.length} entries from the walk`);
check("and says so again", hookLog.filter(h => h === engine.INDEX_READY_HOOK).length >= 2, hookLog.join(", "));

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
