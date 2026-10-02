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
  const first = firstMatches(idx, q, PER_PAGE, engine.rankArtForName);
  const full = engine.rankArtForName(idx.all, q).listed;
  const lastRead = idx.all.indexOf(first.at(-1));
  check("page 1 is found by reading only as far as the twentieth match",
    first.length === 20 && lastRead < idx.all.length - 1,
    `read ${lastRead + 1} of ${idx.all.length} entries for 20 of ${full.length} goblins`);
  check("and it is the same twenty, in the same order, as the full search",
    first.every((e, i) => e.path === full[i].path), `${first.slice(0, 3).map(e => e.fullName).join(", ")}…`);
  /* ⚠️ THE DRIFT PIN. Page 1 and the full list were two substring tests that
     happened to agree, and his Virric files fell through both. */
  check("page 1 is built by the same function as the full list, not a second test",
    /rankFn\(all, query, \{ stopAt: n \}\)/.test(
      readFileSync("D:/FoundryVTT/Data/modules/ace-token-art/scripts/token-art-picker.mjs", "utf8")),
    "firstMatches calls the engine's ranker");
}

/* == ANY WORD OF HIS NAME LISTS THE FILE =================================== */
//
// His report, 2026-10-01: "Virric Vaesoldandros still lists only files with both
// words. Virric 33A, Virric number 1 and Virric token are in the folder and are
// not on that list. A file is listed when any word of his name is a word in the
// file, after a number, a size, and token, number, portrait, img, image and art
// are dropped. Both-words files stay listed and still win the auto-pick."
console.log("");
console.log("THE PICKER'S LIST: ANY WORD OF THE NAME");
{
  const art = (full) => ({ path: `art/${full}.png`, fullName: full,
    fullLower: full.toLowerCase(), baseLower: full.toLowerCase().replace(/\s+\d+[a-z]?$/i, "") });
  const shelf = [
    art("Virric Vaesoldandros"), art("Virric 33A"), art("Virric number 1"),
    art("Virric token"), art("Vaesoldandros Dead"), art("Velikov"),
    art("Crocodile"), art("Roc"),
  ];
  const listed = engine.rankArtForName(shelf, "Virric Vaesoldandros");
  const names = listed.listed.map(e => e.fullName);
  check("his three Virric files are on the list", 
    ["Virric 33A", "Virric number 1", "Virric token"].every(n => names.includes(n)),
    names.join(", "));
  check("the both-words file is still first, so the auto-pick does not move",
    names[0] === "Virric Vaesoldandros" && listed.exact === 1, `${names[0]} — ${listed.exact} named exactly that`);
  check("a file naming only the surname is on it too",
    names.includes("Vaesoldandros Dead"), names.join(", "));
  check("a stranger's file is not", !names.includes("Velikov"), names.join(", "));
  /* ⚠️ WHOLE WORDS, HIS WORDS: "Crocodile is not Roc." */
  const roc = engine.rankArtForName(shelf, "Roc").listed.map(e => e.fullName);
  check("Crocodile is not Roc", roc.includes("Roc") && !roc.includes("Crocodile"), roc.join(", ") || "nothing");
  /* ⚠️ AN EMPTY RESULT IS A FAILURE, NOT AN ANSWER. */
  check("a name nothing holds comes back empty, and the count line says so",
    engine.rankArtForName(shelf, "Zyzzyx").listed.length === 0, "0 listed");
  /* ⚠️ THE EARLY STOP IS A TRUE PREFIX of the full list. */
  const two = engine.rankArtForName(shelf, "Virric", { stopAt: 2 }).listed.map(e => e.fullName);
  const full = engine.rankArtForName(shelf, "Virric").listed.map(e => e.fullName);
  check("stopping early gives the start of the same list",
    two.length === 2 && two.every((n, i) => n === full[i]), two.join(", "));
}
{
  // The real picker, drawn on a stand-in page. The API's full search is timed.
  let fullSearchAt = null;
  const api = {
    getTokenArtIndex: () => engine.getTokenArtIndex(),
    indexReadyHook: engine.INDEX_READY_HOOK,
    searchTokenArt: (query) => {
      fullSearchAt ??= performance.now();
      // ⚠️ THE REAL RANKER, not a second test. A stub that filtered on a
      // substring here is how this test stayed green through the Virric bug.
      return engine.rankArtForName(engine.getTokenArtIndex().all, query).listed
        .map(e => ({ ...e, base: e.displayBase, variant: e.displayVariant }));
    },
    rankArtForName: engine.rankArtForName,
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

/* == THE ONE ALREADY IN USE IS MARKED, IN GREEN ========================= */
//
// His rule, 2026-10-01: "The picture already on the token is marked in green,
// with the word Current. Portrait and prone are marked separately. Gold is not
// the current mark."
//
// Gold is this picker's own colour — panel, header, hover border, selected tab —
// so it cannot also mean "this is the one you are using".
console.log("");
console.log("THE CURRENT PICTURE");
{
  const src = readFileSync("D:/FoundryVTT/Data/modules/ace-token-art/scripts/token-art-picker.mjs",
    "utf8");
  check("the mark is the word Current", /mark\.textContent = "Current";/.test(src), true);
  check("and it is green, not gold",
    /background: "#5fd36a", color: "#0b1a0d",/.test(src)
    && /card\.style\.borderColor = "#5fd36a";/.test(src), true);
  check("each tab answers its own question: texture, portrait, prone flag",
    /if \(_mode === "portrait"\)/.test(src) && /if \(_mode === "prone"\)/.test(src)
    && /same\(tokenDoc\?\.texture\?\.src\)/.test(src)
    && /getFlag\?\.\("ace-qol", "proneArt"\)/.test(src), true);
  check("a creature lying down still counts its standing art as current",
    /same\(tokenDoc\?\.getFlag\?\.\("ace-qol", "proneArtPrevious"\)\)/.test(src), true);
  check("and hover never takes the green off",
    /if \(!_isCurrent\) card\.style\.borderColor = "#d4af37";/.test(src), true);
  check("the paths are compared decoded, so %20 is not a different file",
    /decodeURIComponent\(a\) === decodeURIComponent\(here\)/.test(src), true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
