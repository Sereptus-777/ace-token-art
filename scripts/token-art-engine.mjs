// ─── ACE: Token Art — engine ───────────────────────────────────────────────
// Scans user-defined folders for token art on world load, then auto-matches
// each freshly created token to a file in the index. Match logic:
//
//   • Exact full-name match (actor "Goblin Archer" → "Goblin - Archer.webp"
//                                                  or "Goblin Archer.webp")
//   • Base-name match (actor "Goblin" → all files whose base is "Goblin")
//   • Prefix-stripped retry (Conjured/Summoned/Adult/... stripped, look up again)
//   • Key-token match (normalized word-set, handles SRD-pack underscored names)
//   • Substring fallback
//
// By default the chooser pops up whenever ANY matches exist (1 or more),
// so the GM always has the chance to confirm what art is being applied.
// The `tokenArtSilentOnSingleMatch` setting flips single-match cases to
// silent swap (faster but no visibility into what got applied).
//
// Tokens whose image is already inside one of the user's folders are
// considered "already good" and left alone — no overwrite, no popup.
//
// Filename convention:
//   <BaseName> - <Variant>.webp     (e.g. "Goblin - Archer.webp")
//   <BaseName>.webp                 (no variant, used when actor name is the base)
//   The " - " (space-hyphen-space) is the variant separator.

import { MODULE_ID } from "./ace-token-art.mjs";

import { tokenNameFromArt } from "./art-descriptor.mjs";

const TAG = "ACE: Token Art";
const IMG_EXT_RE = /\.(webp|png|jpg|jpeg|svg|gif|avif)$/i;
const VARIANT_SEP = / - /;          // " - " — what splits base from variant
// CHOOSER_TIMEOUT_MS removed v0.7.21 — chooser waits indefinitely for explicit pick.

// ─── In-memory index ───────────────────────────────────────────────────────
// Built on world load + on demand via rescan. Cleared and re-built atomically.
const _index = {
    /** Map<baseNameLower, Entry[]>  — for "Goblin" → all Goblin variants */
    byBase: new Map(),
    /** Map<fullNameLower, Entry>    — for "Goblin Archer" → exact entry */
    byFullName: new Map(),
    /** Map<keyTokenString, Entry[]> — for fuzzy word-set matching. Lets
     *  "Air Elemental" match files keyed as "air elemental" regardless
     *  of size adjectives, numeric suffixes, underscores, etc. */
    byKey: new Map(),
    /** All entries, in scan order. */
    all: [],
    /** Whether the index has been built at least once. */
    ready: false,
};

// ─── Portrait index (separate folders, separate purpose) ─────────────────────
// Johnny, 2026-08-06: portraits live in their own tree (e.g. NPC portraits) and
// must NEVER be mixed into token art — a portrait on a token looks wrong and a
// top-down token as a portrait looks worse.
//
// Deliberately much simpler than the token index above: no creature-folder vs
// category-bin heuristics, no variant grouping. A portrait is one image of one
// character, searched by filename. Keeping it dumb keeps it predictable.
const _portraits = {
    /** All entries, in scan order: {path, fullName, fullLower, file} */
    all: [],
    ready: false,
};

export function getPortraitIndex() { return _portraits; }

/**
 * (Re)build the portrait index from `tokenArtPortraitFolders`.
 * No cache — portrait folders are small compared to token-art trees, and a
 * stale portrait list is more annoying than a one-second scan.
 */
export async function rebuildPortraitIndex({ silent = false } = {}) {
    const folders = (() => {
        try {
            const raw = game.settings.get(MODULE_ID, "tokenArtPortraitFolders");
            return Array.isArray(raw) ? raw.filter(Boolean) : [];
        } catch (_) { return []; }
    })();

    _portraits.all = [];
    _portraits.ready = false;

    if (!folders.length) {
        _portraits.ready = true;
        console.log(`${TAG} | No portrait folders configured — portrait index empty.`);
        return { fileCount: 0, folders: 0 };
    }

    const t0 = performance.now();
    // ⚠️ ALL ROOTS IN ONE WALK. Looping the folders here re-serialised the
    // scan even after the walk itself was made concurrent: six roots meant six
    // sequential walks, so the fix inside _scanFolders would have been mostly
    // wasted. One call, one bounded pool, all roots.
    let paths = [];
    try { paths = await _scanFolders(folders); }
    catch (err) { console.warn(`${TAG} | Portrait scan failed:`, err?.message ?? err); }

    const seen = new Set();
    for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        const file = decodeURIComponent(String(p).split("/").pop() ?? "");
        const bare = file.replace(/\.[^.]+$/, "");
        const full = _normalizeFilename(bare) || bare;
        _portraits.all.push({ path: p, file, fullName: full, fullLower: full.toLowerCase() });
    }
    _portraits.all.sort((a, b) => a.fullLower.localeCompare(b.fullLower));
    _portraits.ready = true;

    const ms = Math.round(performance.now() - t0);
    console.log(`${TAG} | Portrait index: ${_portraits.all.length} image(s) across ${folders.length} folder(s) in ${ms}ms.`);
    if (!silent) {
        try { ui.notifications?.info(`ACE: Token Art — ${_portraits.all.length.toLocaleString()} portraits indexed.`); }
        catch (_) { /* non-fatal */ }
    }
    return { fileCount: _portraits.all.length, folders: folders.length };
}

// ─── Prone index (its own folders, its own purpose) ──────────────────────────
// Johnny, 2026-09-02: "I want you to build a prone art thing, the same as
// portrait art and token art, under the token art module."
//
// ⚠️ A THIRD KIND, NOT A FILTER OVER THE OTHER TWO. A standing top-down token
// makes a useless prone image and a portrait makes a worse one, so this is a
// separate walk over separate folders, exactly like portraits. Offering the
// wrong kind silently is worse than an empty tab that says which folder to set.
//
// ⚠️ IT DEFAULTS TO THE FOLDER THE ART IS ALREADY IN. ace-qol's prone swapper
// has been reading `modules/ace-qol/Assets/Prone` since 2026-08-11 and Johnny
// has seven files in there. Shipping this with an empty folder list would have
// presented an empty tab to a man who already owns the art.
const _prone = {
    /** All entries, in scan order: {path, fullName, fullLower, file} */
    all: [],
    ready: false,
};

export function getProneIndex() { return _prone; }

/** (Re)build the prone index from `tokenArtProneFolders`. */
export async function rebuildProneIndex({ silent = false } = {}) {
    const folders = (() => {
        try {
            const raw = game.settings.get(MODULE_ID, "tokenArtProneFolders");
            return Array.isArray(raw) ? raw.filter(Boolean) : [];
        } catch (_) { return []; }
    })();

    _prone.all = [];
    _prone.ready = false;

    if (!folders.length) {
        _prone.ready = true;
        console.log(`${TAG} | No prone folders configured — prone index empty.`);
        return { fileCount: 0, folders: 0 };
    }

    const t0 = performance.now();
    let paths = [];
    try { paths = await _scanFolders(folders); }
    catch (err) { console.warn(`${TAG} | Prone scan failed:`, err?.message ?? err); }

    const seen = new Set();
    for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        const file = decodeURIComponent(String(p).split("/").pop() ?? "");
        // ⚠️ THE `prone-` PREFIX IS A FILING CONVENTION, NOT PART OF THE NAME.
        // Leaving it on makes every card in the grid read "Prone Firaxis" and
        // makes a search for "firaxis" score worse than it should.
        const bare = file.replace(/\.[^.]+$/, "").replace(/^prone[-_ ]*/i, "");
        const full = _normalizeFilename(bare) || bare;
        _prone.all.push({ path: p, file, fullName: full, fullLower: full.toLowerCase() });
    }
    _prone.all.sort((a, b) => a.fullLower.localeCompare(b.fullLower));
    _prone.ready = true;

    const ms = Math.round(performance.now() - t0);
    console.log(`${TAG} | Prone index: ${_prone.all.length} image(s) across ${folders.length} folder(s) in ${ms}ms.`);
    if (!silent) {
        try { ui.notifications?.info(`ACE: Token Art — ${_prone.all.length.toLocaleString()} prone images indexed.`); }
        catch (_) { /* non-fatal */ }
    }
    return { fileCount: _prone.all.length, folders: folders.length };
}

// Active chooser DOM element — tracked so we can dismiss the previous one
// before a new spawn pops a new chooser on top of it.
let _activeChooser = null;

// Folder names that are "generic containers" — when a token file lives
// inside one of these, we DON'T treat the folder name as the creature
// name (it's just an organizational bucket). Anything else becomes the
// creature-name source of truth, so e.g. `MM/Air Elemental/Air_01.png`
// uses "Air Elemental" as the base regardless of what's in the filename.
const GENERIC_FOLDERS = new Set([
    "npcs", "tokens", "token", "bestiary", "monsters", "monster",
    "creatures", "creature", "portraits", "portrait",
    "art", "artwork", "images", "img",
    "mm", "phb", "vgm", "mtof", "mpmm", "tcoe", "ftod", "boem",
    "srd", "srd5e", "system", "systems", "good", "pngs", "png",
    "monster png-good only", "monster-png-good-only",
]);

// Words to ignore when computing a creature's "key signature" — sizes,
// numeric tokens, "v01"-style variant markers, and the common modifier
// prefixes already in STRIP_TOKENS. Used to make
//   "Air_Large_Elemental_01"  match
//   "Air Elemental"           (after stripping Large + 01).
const SIZE_TOKENS = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan"]);
const NUMERIC_RE  = /^\d+$|^v\d+$|^\(\d+\)$/i;

// ── Creature families for taxonomic folder matching ───────────────────────
// When an actor like "Goblin Archer" drops, the engine first tries to find a
// match inside a folder whose name matches the actor's creature FAMILY
// (e.g. files inside "goblinoids/" or "goblinoid/" for any goblin-family
// creature). Only kicks in when multiple matches exist — family-folder
// matches win over generic-folder matches.
//
// Mirrors CREATURE_FAMILIES in ace-engine/scripts/npc/faction-registry.mjs
// so this module stays self-contained (no cross-module import).
const CREATURE_FAMILIES = {
    goblinoid: ["goblin", "hobgoblin", "bugbear"],
    orcish:    ["orc", "half-orc"],
    underdark: ["drow", "duergar", "svirfneblin"],
    undead:    ["skeleton", "zombie", "undead", "wight", "ghoul", "ghost", "wraith", "lich", "vampire"],
    construct: ["construct", "golem", "homunculus", "scarecrow"],
    canine:    ["wolf", "worg", "dire wolf", "hyena", "jackal", "dog"],
    criminal:  ["bandit", "thug", "pirate", "assassin", "cutpurse", "highwayman"],
    military:  ["guard", "soldier", "knight", "veteran", "captain", "sergeant"],
    civilian:  ["commoner", "merchant", "priest", "bartender", "barmaid", "innkeeper", "noble", "scholar"],
    cultist:   ["cultist", "acolyte", "fanatic"],
    giantkin:  ["giant", "ogre", "ettin", "troll"],
    fey:       ["dryad", "satyr", "pixie", "sprite", "nymph", "fey"],
    fiend:     ["devil", "demon", "imp", "succubus", "incubus", "fiend"],
    elemental: ["elemental", "azer", "myrmidon", "salamander", "magmin"],
    dragonkin: ["dragon", "wyvern", "drake", "dragonborn", "kobold"],
    aberration:["aboleth", "mind flayer", "illithid", "beholder", "gibbering"],
};

// Reverse lookup: creature word → family key
const _creatureWordToFamily = {};
for (const [family, members] of Object.entries(CREATURE_FAMILIES)) {
    for (const m of members) _creatureWordToFamily[m.toLowerCase()] = family;
}

// Folder name → family key. Accepts singular and common plural / adjective
// forms — AND every individual creature word in CREATURE_FAMILIES. So a
// folder named "GOBLIN" or "Goblins" maps to the goblinoid family, "DROW"
// or "Drows" maps to underdark, "SKELETONS" maps to undead, etc. Users
// rarely name folders after taxonomic families; they name them after
// creatures. Both work now.
const _familyFolderMap = {};
for (const [family, members] of Object.entries(CREATURE_FAMILIES)) {
    _familyFolderMap[family]       = family;  // "goblinoid"
    _familyFolderMap[family + "s"] = family;  // "goblinoids"
    for (const m of members) {
        const mLower = m.toLowerCase();
        _familyFolderMap[mLower]       = family;  // "goblin"  → goblinoid
        _familyFolderMap[mLower + "s"] = family;  // "goblins" → goblinoid
    }
}
// Pluralization / adjective edge cases (must come AFTER the loop above —
// some override the auto-generated entries).
_familyFolderMap["orcish"]      = "orcish";
_familyFolderMap["fey"]         = "fey";
_familyFolderMap["fiendish"]    = "fiend";
_familyFolderMap["aberrations"] = "aberration";
_familyFolderMap["dragonkin"]   = "dragonkin";
_familyFolderMap["giantkin"]    = "giantkin";

/** Decode URL-encoded path segments — Foundry's FilePicker returns paths
 *  with %20 for spaces, %26 for &, etc. Normalize that before matching
 *  folder names. Also trims and lowercases. */
function _decodeAndNormalize(s) {
    let decoded = String(s ?? "");
    try { decoded = decodeURIComponent(decoded); } catch (_) { /* malformed — use raw */ }
    return _normalizeFilename(decoded).toLowerCase();
}

/** Detect family folder anywhere in a file's path. Returns the family
 *  key (e.g. "goblinoid") or null if no parent folder matches. Walks
 *  from deepest parent to shallowest so the closest family wins. */
function _detectFamilyFolderInPath(path) {
    const parts = String(path ?? "").split("/");
    // Skip the filename itself (last part); walk parents
    for (let i = parts.length - 2; i >= 0; i--) {
        const folderName = _decodeAndNormalize(parts[i]);
        if (_familyFolderMap[folderName]) return _familyFolderMap[folderName];
    }
    return null;
}

/** Detect actor's creature family from its name. Scans each whitespace-
 *  separated token (so "Goblin Archer" finds "goblin" → goblinoid). Also
 *  checks for two-word creature words like "dire wolf". Returns family key
 *  or null. */
function _detectActorFamily(actorName) {
    const lower = _normalizeFilename(actorName).toLowerCase().trim();
    if (!lower) return null;
    // Try multi-word matches first (e.g. "dire wolf")
    for (const word of Object.keys(_creatureWordToFamily)) {
        if (word.includes(" ") && lower.includes(word)) {
            return _creatureWordToFamily[word];
        }
    }
    // Then single-word
    for (const token of lower.split(/\s+/)) {
        if (_creatureWordToFamily[token]) return _creatureWordToFamily[token];
    }
    return null;
}

/**
 * Normalize a filename or folder name into a sane lookup string.
 *   • URL-decode    → "%20" becomes " "  (Foundry's FilePicker returns URL-escaped paths)
 *   • underscores   → spaces             ("goblin_archer" → "goblin archer")
 *   • inline hyphens → spaces            ("goblin-warrior" → "goblin warrior")
 *                     — but " - " is preserved as the variant separator
 *   • CamelCase     → "Camel Case"       ("AirMyrmidon" → "Air Myrmidon")
 *   • multiple spaces collapse
 *
 * Hyphen handling: `goblin-warrior.webp` previously stayed as one token
 * "goblin-warrior", invisible to actor "Goblin Warrior" or "Goblin" lookups.
 * Now an inline hyphen (NOT padded by spaces) becomes a space. The " - "
 * convention (space-hyphen-space) is preserved as the variant separator so
 * files like `Goblin - Archer.webp` still split into base="Goblin"
 * variant="Archer". Compound species names like "Half-Orc" are normalized
 * to "Half Orc" — matches actors named either way after normalization.
 */
function _normalizeFilename(s) {
    let str = String(s || "");
    // URL-decode (Foundry FilePicker returns paths with %20 etc.)
    try { str = decodeURIComponent(str); } catch (_) { /* malformed escape — leave as-is */ }
    return str
        // Underscores → spaces
        .replace(/[_]+/g, " ")
        // Inline hyphen → space, but leave " - " alone (variant separator).
        // The negative lookbehind/lookahead asserts no surrounding space.
        .replace(/(?<!\s)-(?!\s)/g, " ")
        // CamelCase splits: aB → a B, ABc → A Bc (handles acronyms like "AIWizard" → "AI Wizard")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        // Collapse whitespace
        .replace(/\s+/g, " ")
        .trim();
}

/** Compute the "key signature" of a name — sorted, lowercased, dedup'd
 *  word set with sizes / numbers / modifier prefixes stripped. Used for
 *  fuzzy matching by word set. */
function _keyTokensOf(name) {
    const words = _normalizeFilename(name).toLowerCase().split(" ");
    const kept = words.filter(w =>
        w && !SIZE_TOKENS.has(w) && !STRIP_TOKENS.has(w) && !NUMERIC_RE.test(w)
    );
    // Dedup + sort for stable signature
    const uniq = [...new Set(kept)].sort();
    return uniq.join(" ");
}

/** Plain entry shape. */
function _makeEntry({ path, displayBase, displayVariant, fullName }) {
    return {
        path,
        displayBase,
        displayVariant: displayVariant || null,
        fullName,
        baseLower: displayBase.toLowerCase().trim(),
        fullLower: fullName.toLowerCase().trim(),
        variantLower: displayVariant ? displayVariant.toLowerCase().trim() : null,
        keyTokens:    _keyTokensOf(fullName),
        // Taxonomic-folder marker — set if any parent folder name is a
        // recognized creature family. Used by _preferFamilyFolder to bump
        // family-matching art ahead of equally-good non-family matches.
        familyFolder: _detectFamilyFolderInPath(path),
    };
}

/** Rank helper — when multiple matches exist and the actor belongs to a
 *  creature family (goblinoid, undead, etc.), RANK family-folder entries
 *  first but keep ALL matches visible in the chooser.
 *
 *  v0.7.21: previously FILTERED non-family-folder matches OUT entirely.
 *  That hid the user's custom token variants (e.g. 20 hand-curated goblin
 *  variants in his own folder) whenever an SRD pack happened to have a
 *  single file inside a "goblinoid" category folder. The SRD entry would
 *  win and all custom variants disappeared from the chooser.
 *
 *  Per Johnny 2026-06-09: "I've got Goblin Archer, Goblin Warrior, Goblin
 *  Hexer, Goblin Boss, Goblin on a Dog... yet it still only sometimes
 *  comes up with only one image." Root cause was this filter. */
function _preferFamilyFolder(matches, actorFamily) {
    if (!actorFamily || !Array.isArray(matches) || matches.length <= 1) return matches;
    const familyHits = matches.filter(m => m && m.familyFolder === actorFamily);
    if (!familyHits.length) return matches;
    const others = matches.filter(m => m && m.familyFolder !== actorFamily);
    return [...familyHits, ...others];
}

// (The old single-file _parsePath was replaced by the two-pass scan in
// rebuildTokenArtIndex below — see "Pass 1 / Pass 2" there. Old logic
// always treated the parent folder as the creature, which mis-grouped
// SRD-pack-style "category bin" folders where each file is actually a
// different creature.)

// ─── Folder scanning ───────────────────────────────────────────────────────

// ─── Persistent index cache ────────────────────────────────────────────────
// Saves the parsed index to a JSON file under the world folder so reload
// doesn't have to re-scan thousands of files every time. Cache is loaded
// on world ready (unless folder list changed since last save). The Rescan
// Folders button forces a full re-scan and refreshes the cache.

const CACHE_VERSION = 2;  // bump when the entry schema changes
const CACHE_DIR  = (worldId) => `worlds/${worldId}/ace-token-art`;
const CACHE_FILE = "index-cache.json";

/** Save the current in-memory index to a JSON cache file. */
async function _saveIndexCache(folders) {
    if (!_index.ready || !game.world?.id) return;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const dir = CACHE_DIR(game.world.id);
    const payload = {
        version: CACHE_VERSION,
        savedAt: new Date().toISOString(),
        folders: folders.slice(),
        // Cache only the FIELDS that come from parsing the path; the
        // derived fields (baseLower, fullLower, keyTokens, familyFolder)
        // are recomputed by _makeEntry on load so changes to the
        // normalization rules pick up automatically.
        entries: _index.all.map(e => ({
            path: e.path,
            displayBase: e.displayBase,
            displayVariant: e.displayVariant ?? null,
            fullName: e.fullName,
        })),
    };
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: "application/json" });
    const file = new File([blob], CACHE_FILE, { type: "application/json" });
    // Ensure the cache directory exists before uploading
    try { await FP.browse("data", dir); }
    catch (_) {
        try { await FP.createDirectory("data", `worlds/${game.world.id}`); } catch (_) {}
        try { await FP.createDirectory("data", dir); } catch (_) {}
    }
    try {
        // suppress "uploaded" toast — this is internal bookkeeping
        const _origInfo = ui.notifications?.info;
        if (ui.notifications) ui.notifications.info = () => {};
        try {
            await FP.upload("data", dir, file, { notify: false });
        } finally {
            if (ui.notifications && _origInfo) ui.notifications.info = _origInfo;
        }
        console.log(`${TAG} | Cache saved: ${payload.entries.length} entries, ${(json.length / 1024).toFixed(1)} KB`);
    } catch (err) {
        console.warn(`${TAG} | Cache save failed:`, err?.message ?? err);
    }
}

/** Try to load the JSON cache. Returns null on miss or schema mismatch. */
async function _loadIndexCache() {
    if (!game.world?.id) return null;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const dir = CACHE_DIR(game.world.id);
    const path = `${dir}/${CACHE_FILE}`;
    try {
        // Existence check via FilePicker.browse (avoids a 404 in the console
        // every load when the cache hasn't been built yet).
        let exists = false;
        try {
            const listing = await FP.browse("data", dir);
            exists = (listing?.files ?? []).some(f => f.endsWith(CACHE_FILE));
        } catch (_) { return null; }
        if (!exists) return null;
        const r = await fetch(`/${path}?_=${Date.now()}`);
        if (!r.ok) return null;
        const data = await r.json();
        if (data?.version !== CACHE_VERSION) {
            console.log(`${TAG} | Cache schema version mismatch (got ${data?.version}, expected ${CACHE_VERSION}) — will rebuild.`);
            return null;
        }
        return data;
    } catch (err) {
        console.warn(`${TAG} | Cache load failed (will rebuild):`, err?.message ?? err);
        return null;
    }
}

/** Rebuild in-memory index Maps from a cached entries array. */
function _hydrateIndexFromCache(entries) {
    _index.byBase    = new Map();
    _index.byFullName = new Map();
    _index.byKey     = new Map();
    _index.all       = [];
    for (const e of entries) {
        const entry = _makeEntry({
            path: e.path,
            displayBase: e.displayBase,
            displayVariant: e.displayVariant,
            fullName: e.fullName,
        });
        _index.all.push(entry);
        if (!_index.byFullName.has(entry.fullLower)) _index.byFullName.set(entry.fullLower, entry);
        const baseArr = _index.byBase.get(entry.baseLower);
        if (baseArr) baseArr.push(entry); else _index.byBase.set(entry.baseLower, [entry]);
        if (entry.keyTokens) {
            const keyArr = _index.byKey.get(entry.keyTokens);
            if (keyArr) keyArr.push(entry); else _index.byKey.set(entry.keyTokens, [entry]);
        }
    }
    _index.ready = true;
}

// ─── ⚠️🔴 THE SCAN WAS SEQUENTIAL, AND THAT IS THE WHOLE MYSTERY ─────────────
//
// Johnny, for months: token art loads instantly sometimes and takes forever
// other times, with no obvious pattern. There IS a pattern. It is cache hit
// versus full walk, and the full walk was as slow as it is possible to make it.
//
// The old version awaited ONE FilePicker.browse at a time, in a plain queue.
// Every directory in the tree was a separate round trip taken strictly after
// the previous one finished. On top of that the CALLERS looped over the
// configured root folders one at a time as well. So a library of, say, 400
// creature folders across 6 roots was 400+ serialised requests, and the total
// time was the sum of every single latency rather than the longest few.
//
// Nothing about that was necessary. `_batchedForEach` — bounded concurrency —
// was already sitting in this very file, written for the integrity sampler and
// never used for the thing that actually hurts.
//
// ⚠️ CONCURRENCY MAKES ORDER NONDETERMINISTIC, AND THAT MATTERS HERE. The old
// walk returned paths in a fixed breadth-first order, and downstream grouping
// picks variants out of that list. Left alone, two scans of an unchanged
// library could produce different art for the same creature, which would read
// as a haunting rather than a bug. The result is sorted before it is returned,
// so the order is now stable BY DEFINITION rather than by accident.
//
// ⚠️ THE POOL IS BOUNDED ON PURPOSE. Firing every directory at once would be
// faster on a local disk and would hammer a hosted Foundry (Forge, Molten) hard
// enough to be throttled or to stall the world for everyone. Eight is what the
// integrity sampler in this file already uses against the same API.
const SCAN_CONCURRENCY = 8;

/**
 * Walk every configured root at once, breadth-first, a bounded level at a time.
 *
 * @param {string[]} rootPaths
 * @returns {Promise<string[]>} image paths, deduplicated and sorted
 */
async function _scanFolders(rootPaths) {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const found = [];
    const visited = new Set();
    let level = [...new Set(rootPaths.filter(Boolean))];
    let dirCount = 0;

    while (level.length) {
        const next = [];
        // ⚠️ visited is checked and set BEFORE the first await, so two copies of
        // the same directory inside one batch cannot both browse it. Moving that
        // check after the await would reintroduce duplicate work silently.
        await _batchedForEach(level, SCAN_CONCURRENCY, async (dir) => {
            if (visited.has(dir)) return;
            visited.add(dir);
            dirCount++;

            let result;
            try {
                result = await FP.browse("data", dir);
            } catch (err) {
                console.warn(`${TAG} | Can't browse "${dir}":`, err?.message ?? err);
                return;
            }
            for (const file of result.files ?? []) {
                if (IMG_EXT_RE.test(file)) found.push(file);
            }
            for (const sub of result.dirs ?? []) next.push(sub);
        });
        level = next;
    }

    found.sort();
    console.log(`${TAG} | Walked ${dirCount} director${dirCount === 1 ? "y" : "ies"} `
        + `(${SCAN_CONCURRENCY} at a time) and found ${found.length} image(s).`);
    return found;
}

/**
 * (Re)build the in-memory token-art index from the user's configured folders.
 *
 * Call sites:
 *   • activateTokenArtEngine() on world ready — passes useCache: true so a
 *     prior run's cache loads instantly (no FilePicker round-trips).
 *   • Folder Configuration dialog "Rescan Now" — passes useCache: false to
 *     force a fresh disk scan.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.useCache=true] — load from `worlds/<id>/ace-token-art/index-cache.json` when configured folders match
 * @param {boolean} [opts.silent=false]  — suppress the "scanning…" toast (used by background reloads)
 */
export async function rebuildTokenArtIndex({ useCache = true, silent = false } = {}) {
    const folders = (() => {
        try {
            const raw = game.settings.get(MODULE_ID, "tokenArtFolders");
            return Array.isArray(raw) ? raw : [];
        } catch (_) { return []; }
    })();

    // ── Try the persistent cache first ──
    if (useCache) {
        const cache = await _loadIndexCache();
        if (cache?.entries?.length) {
            // Only trust the cache if the folder list matches exactly.
            // If the GM added/removed folders we MUST rescan to pick up
            // the new/missing files.
            const cachedFolders = Array.isArray(cache.folders) ? cache.folders : [];
            if (JSON.stringify(cachedFolders) === JSON.stringify(folders)) {
                _hydrateIndexFromCache(cache.entries);
                console.log(`${TAG} | Loaded ${cache.entries.length} entries from cache (saved ${cache.savedAt}). Skip rescan — Rescan Folders to refresh.`);
                if (!silent) {
                    try { ui.notifications?.info?.(`ACE: Token Art — loaded ${cache.entries.length.toLocaleString()} entries from cache (instant). Rescan Folders to pick up new art.`); }
                    catch (_) { /* non-fatal */ }
                }
                return { fileCount: cache.entries.length, baseCount: _index.byBase.size, fromCache: true };
            }
            console.log(`${TAG} | Cache folder list differs from current setting — full rescan needed.`);
        }
    }

    if (!folders.length) {
        console.log(`${TAG} | No folders configured — index empty.`);
        _index.byBase.clear();
        _index.byFullName.clear();
        _index.all = [];
        _index.ready = true;
        return { fileCount: 0, baseCount: 0 };
    }

    console.log(`${TAG} | Scanning ${folders.length} folder(s)…`);
    // Persistent notification while we scan — auto-dismissed below.
    let scanNotification = null;
    if (!silent) {
        try {
            scanNotification = ui.notifications?.info?.(`ACE: Token Art — scanning ${folders.length} folder${folders.length === 1 ? "" : "s"}… (cached for next reload)`, { permanent: true });
        } catch (_) { /* non-fatal */ }
    }
    const t0 = performance.now();

    // ⚠️ ONE WALK ACROSS EVERY ROOT — see the note on _scanFolders. This loop
    // was the outer half of the same serialisation.
    const allPaths = await _scanFolders(folders);
    // Dedupe by path (the walk already dedupes directories, not files across roots)
    const uniquePaths = [...new Set(allPaths)];

    // Set of scan-root paths (lowercased, no trailing slash) so _parsePath
    // knows where to stop when walking up looking for a creature folder.
    const scanRoots = new Set(folders.map(f => f.toLowerCase().replace(/\/+$/, "")));

    // ── Pass 1: group files by parent folder + decide which folders are
    //    "creature folders" (folder name = the creature, files are variants)
    //    vs "category bins" (folder is just an organizational container,
    //    each file is a different creature).
    //
    //    Heuristic: a folder is a creature folder if MOST of its files share
    //    at least one significant word with the folder name. So:
    //      Goblin/Goblin_01.png + Goblin_02.png  → creature folder
    //      Goblin/Goblin Boss.webp                → creature folder
    //      "Air Elemental"/AirMyrmidon, Azer, Dao → bin (no word overlap
    //                                                with "Air Elemental"
    //                                                for most filenames)
    const SIG_WORDS_RE = /[a-z0-9]{3,}/g;
    const significantWords = (s) => {
        const lower = _normalizeFilename(s).toLowerCase();
        return new Set((lower.match(SIG_WORDS_RE) ?? []).filter(w =>
            !SIZE_TOKENS.has(w) && !STRIP_TOKENS.has(w) && !NUMERIC_RE.test(w) &&
            !GENERIC_FOLDERS.has(w)
        ));
    };

    /** key = parent folder path; value = { folderName, folderWords, files: [{path, sharedWithFolder}] } */
    const folderGroups = new Map();
    for (const path of uniquePaths) {
        const parts = path.split("/");
        const filenameRaw = parts.pop().replace(/\.[^.]+$/, "");

        // Find the deepest non-generic, non-scan-root parent folder
        let parentFolder = "";
        let parentPath = "";
        for (let i = parts.length - 1; i >= 0; i--) {
            const folderName = _normalizeFilename(parts[i]);
            const lower = folderName.toLowerCase();
            const pathSoFar = parts.slice(0, i + 1).join("/").toLowerCase();
            if (scanRoots.has(pathSoFar)) break;
            if (GENERIC_FOLDERS.has(lower)) continue;
            if (!folderName) continue;
            parentFolder = folderName;
            parentPath = parts.slice(0, i + 1).join("/");
            break;
        }

        const folderWords = parentFolder ? significantWords(parentFolder) : new Set();
        const fileWords = significantWords(filenameRaw);
        const sharedWithFolder = parentFolder
            ? [...fileWords].some(w => folderWords.has(w))
            : false;

        const key = parentPath || "__ROOT__";
        if (!folderGroups.has(key)) {
            folderGroups.set(key, { folderName: parentFolder, folderWords, files: [] });
        }
        folderGroups.get(key).files.push({
            path,
            filenameRaw,
            sharedWithFolder,
            fileWords,
        });
    }

    // Decide per-folder: creature folder, or bin?
    const folderModes = new Map();   // key → "creature" | "filename"
    for (const [key, group] of folderGroups.entries()) {
        if (!group.folderName) {
            folderModes.set(key, "filename");
            continue;
        }
        if (group.files.length === 1) {
            // Single file: treat folder as creature only if filename shares
            // a word with folder name (otherwise filename is independent).
            folderModes.set(key, group.files[0].sharedWithFolder ? "creature" : "filename");
            continue;
        }
        // Multi-file: creature folder if MOST files share a word with folder
        const sharedCount = group.files.filter(f => f.sharedWithFolder).length;
        const ratio = sharedCount / group.files.length;
        folderModes.set(key, ratio >= 0.5 ? "creature" : "filename");
    }

    // ── Pass 2: build entries using the per-folder mode ──────────────
    const byBase = new Map();
    const byFullName = new Map();
    const byKey = new Map();
    const all = [];
    let creatureFolderCount = 0, binFolderCount = 0;
    for (const [key, group] of folderGroups.entries()) {
        const mode = folderModes.get(key);
        if (mode === "creature") creatureFolderCount++;
        else binFolderCount++;
        for (const file of group.files) {
            let displayBase, displayVariant;
            const filenameNorm = _normalizeFilename(file.filenameRaw);
            if (mode === "creature" && group.folderName) {
                // Folder is the creature; strip folder words from filename
                // to get the variant label.
                displayBase = group.folderName;
                const baseWordSet = new Set(
                    group.folderName.toLowerCase().split(" ").filter(Boolean)
                );
                const variantWords = filenameNorm.split(" ").filter(w => !baseWordSet.has(w.toLowerCase()));
                displayVariant = variantWords.join(" ").trim() || null;
            } else {
                // Filename is the creature. Use the " - " separator pattern
                // if present, otherwise the whole filename is the base.
                const split = filenameNorm.split(VARIANT_SEP);
                displayBase = split[0].trim();
                displayVariant = split.length > 1 ? split.slice(1).join(" - ").trim() : null;
            }

            const fullName = displayVariant ? `${displayBase} ${displayVariant}` : displayBase;
            const entry = _makeEntry({ path: file.path, displayBase, displayVariant, fullName });
            all.push(entry);

            // Build indexes
            if (!byFullName.has(entry.fullLower)) byFullName.set(entry.fullLower, entry);
            const baseArr = byBase.get(entry.baseLower);
            if (baseArr) baseArr.push(entry);
            else byBase.set(entry.baseLower, [entry]);
            if (entry.keyTokens) {
                const keyArr = byKey.get(entry.keyTokens);
                if (keyArr) keyArr.push(entry);
                else byKey.set(entry.keyTokens, [entry]);
            }
        }
    }

    _index.byBase = byBase;
    _index.byFullName = byFullName;
    _index.byKey = byKey;
    _index.all = all;
    _index.ready = true;

    const ms = (performance.now() - t0).toFixed(0);
    console.log(`${TAG} | Index built in ${ms}ms — ${all.length} files, ${byBase.size} unique base names, ${byKey.size} key signatures, ${creatureFolderCount} creature folders, ${binFolderCount} category folders.`);

    // Dismiss the in-progress toast (if any) and replace with a completion one.
    try {
        if (scanNotification?.remove) scanNotification.remove();
        else if (typeof scanNotification === "number" && ui.notifications?.queue) {
            // legacy notification id shape — best effort
            ui.notifications.queue = ui.notifications.queue.filter(n => n.id !== scanNotification);
        }
    } catch (_) { /* non-fatal */ }
    if (!silent) {
        try {
            ui.notifications?.info?.(`ACE: Token Art — ${all.length.toLocaleString()} files / ${byBase.size.toLocaleString()} creatures indexed (${ms}ms) — cached for next reload`);
        } catch (_) { /* non-fatal */ }
    }

    // Persist the fresh index so the next world load is instant. Fire-and-
    // forget; failures only mean we'll rescan again next time.
    _saveIndexCache(folders).catch(err => console.warn(`${TAG} | Cache save (non-fatal):`, err));

    return { fileCount: all.length, baseCount: byBase.size };
}

/** Get the live index (for settings UI / debugging). */
export function getTokenArtIndex() { return _index; }

// ─── Matching ──────────────────────────────────────────────────────────────

/**
 * Common modifier prefixes (and adjectives elsewhere) we strip out so a
 * summoned/conjured/spectral version of a creature still matches the
 * base creature's art. Spell-summoned creatures get prefixes like
 * "Conjured Air Elemental" or "Summoned Wolf"; resurrection effects
 * produce things like "Skeletal Ogre"; etc.
 */
const STRIP_TOKENS = new Set([
    "conjured", "summoned", "spectral", "phantasmal", "phantom", "ghostly",
    "skeletal", "zombified", "possessed", "shadow", "spirit", "young",
    "adult", "ancient", "wyrmling", "elder", "greater", "lesser", "dire",
    "giant", "swarm",
]);

/**
 * Build a normalized lookup string from the actor name by stripping
 * one or more leading modifier words. Returns the stripped form.
 *   "Conjured Air Elemental"  → "air elemental"
 *   "Adult Red Dragon"        → "red dragon"
 *   "Goblin Boss"             → "goblin boss"  (no leading modifier)
 *   "Summoned Spectral Wolf"  → "wolf"          (two strips)
 */
function _stripModifierPrefixes(lower) {
    let words = lower.split(/\s+/);
    let changed = true;
    while (changed && words.length > 1) {
        changed = false;
        if (STRIP_TOKENS.has(words[0])) {
            words = words.slice(1);
            changed = true;
        }
    }
    return words.join(" ").trim();
}

/**
 * Strip noise from actor names that breaks matching:
 *   • parenthetical suffixes  "Goblin (CR 1/4)" → "Goblin"
 *                             "Bandit (Crossbow)" → "Bandit"
 *   • bracketed suffixes      "Goblin [SK]" → "Goblin"
 *   • trailing numbers        "Goblin 2", "Goblin #3" → "Goblin"
 *   • trailing single letter  "Orc A" → "Orc"
 *   • leading article "The"   "The Goblin" → "Goblin"
 *   • surrounding whitespace
 *
 * Stays lowercase for downstream lookup keys. Idempotent — applying
 * twice yields the same result.
 */
function _stripActorNameNoise(lower) {
    return String(lower ?? "")
        .replace(/\s*\([^)]*\)\s*/g, " ")    // parenthetical suffixes
        .replace(/\s*\[[^\]]*\]\s*/g, " ")    // bracketed suffixes
        .replace(/\s*[#]?\s*\d+\s*$/, "")     // trailing numbers / "#3"
        .replace(/\s+[a-z]$/i, "")            // trailing single letter ("Orc A")
        .replace(/^the\s+/i, "")              // leading "the"
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Find candidate art for an actor by name.
 * Returns { matches: Entry[], reason: "exact" | "base" | "stripped" | "key" | "substring" | "none" }
 */
function _findMatches(actorName) {
    const rawLower = (actorName || "").toLowerCase().trim();
    if (!rawLower) return { matches: [], reason: "none" };

    // Strip parenthetical CR suffixes, brackets, trailing numbers, "the",
    // etc. BEFORE running lookups. Otherwise an actor named "Goblin (CR 1/4)"
    // doesn't match anything by base/prefix and falls through to the
    // substring fallback — which only returns the literal "Goblin.webp"
    // files (7), missing the other 400+ goblin variants entirely.
    const lower = _stripActorNameNoise(rawLower) || rawLower;

    // Detect the actor's creature family ("goblin" → goblinoid, "skeleton"
    // → undead, etc.). Used to bias each match step toward art that lives
    // inside a taxonomic folder (e.g. NPCs/goblinoids/*). Falls through to
    // normal behavior when no family or no taxonomic-folder hits exist.
    const actorFamily = _detectActorFamily(lower);

    // 1+2. Combined exact + base + prefix expansion — gather ALL candidates,
    //      don't short-circuit on an exact hit. If actor "Goblin" matches
    //      a literal "Goblin.webp" via exact AND there are 400+ files whose
    //      base STARTS with "Goblin " (Goblin Boss, Goblin Archer, etc.),
    //      we want to surface ALL of them in the chooser — the exact match
    //      becomes one of many options ranked at the top. Short-circuiting
    //      on exact match was the reason "Goblin (CR 1/4)" → after noise
    //      strip "goblin" → only the one literal Goblin.webp showed up.
    const candidates = [];
    const seen = new Set();
    const pushUnique = (e) => {
        if (!e || seen.has(e.path)) return;
        seen.add(e.path);
        candidates.push(e);
    };

    // Exact full-name match — push first so it ranks at top
    const exact = _index.byFullName.get(lower);
    if (exact) pushUnique(exact);

    // Base-name match
    const baseHits = _index.byBase.get(lower);
    if (baseHits?.length) {
        for (const e of baseHits) pushUnique(e);
    }

    // Prefix expansion — every file whose base or fullName starts with "<name> "
    const prefix = lower + " ";
    for (const e of _index.all) {
        if (e.baseLower.startsWith(prefix) || e.fullLower.startsWith(prefix)) {
            pushUnique(e);
        }
    }

    if (candidates.length) {
        const reasonParts = [];
        if (exact) reasonParts.push("exact");
        if (baseHits?.length) reasonParts.push("base");
        if (candidates.length > (exact ? 1 : 0) + (baseHits?.length ?? 0)) reasonParts.push("prefix");
        return { matches: _preferFamilyFolder(candidates, actorFamily), reason: reasonParts.join("+") || "base" };
    }

    // 3. Strip modifier prefixes (Conjured/Summoned/Adult/...) and retry
    //    exact + base lookups. Most useful for spell-summoned creatures
    //    like "Conjured Air Elemental" → "Air Elemental".
    const stripped = _stripModifierPrefixes(lower);
    if (stripped && stripped !== lower) {
        const strippedExact = _index.byFullName.get(stripped);
        if (strippedExact) return { matches: [strippedExact], reason: "stripped" };
        const strippedBase = _index.byBase.get(stripped);
        if (strippedBase?.length) return { matches: _preferFamilyFolder(strippedBase.slice(), actorFamily), reason: "stripped" };
    }

    // 4. Key-token match — normalize underscores/sizes/numbers and look
    //    up by sorted word set. Catches the user's SRD-pack layout:
    //      actor "Air Elemental"            → key "air elemental"
    //      files "Air_Large_Elemental_01..." → also key "air elemental"
    //    All 9 numbered variants resolve to the same actor.
    //    Try the original name first, then the modifier-stripped name.
    for (const candidate of [lower, stripped].filter(Boolean)) {
        const key = _keyTokensOf(candidate);
        if (!key) continue;
        const keyHits = _index.byKey.get(key);
        if (keyHits?.length) return { matches: _preferFamilyFolder(keyHits.slice(), actorFamily), reason: "key" };
    }

    // 5. Substring fallback — actor "Goblin Boss" might match base "Goblin"
    //    if no "Goblin Boss.webp" exists. Picks the LONGEST matching base.
    //    Also catches cases the prefix-strip missed.
    let bestBase = null;
    for (const [base, entries] of _index.byBase.entries()) {
        if (lower.includes(base) && (!bestBase || base.length > bestBase.length)) {
            bestBase = base;
        }
    }
    const substringHits = bestBase ? _index.byBase.get(bestBase).slice() : [];

    // 5b. Species-token broadening — when the actor name has multiple
    //     tokens AND one of them is a recognized creature word
    //     (goblin/orc/wolf/etc.), surface EVERY indexed file whose path
    //     or name contains that creature word — regardless of folder
    //     location. Fixes: actor "Goblin Minion" with 19 indexed goblin
    //     variants (Goblin-Warrior-1.webp, Goblin-Boss.webp, ...) used to
    //     return only the 8 files that happened to live in a parent
    //     folder named "GOBLIN". Now ALL 19 surface, scattered or not.
    //     Added 2026-06-09 — same session that fixed the chooser cap
    //     and family-folder filter regressions.
    const lowerTokens = lower.split(/\s+/).filter(Boolean);
    const creatureToken = lowerTokens.find(t => _creatureWordToFamily[t]);
    let speciesHits = [];
    if (creatureToken && lowerTokens.length > 1) {
        speciesHits = _index.all.filter(e =>
            e.baseLower.includes(creatureToken) || e.fullLower.includes(creatureToken)
        );
    }

    // Merge step-5 substring + step-5b species, dedup by path. Substring
    // matches rank first (more specific), species matches second.
    if (substringHits.length || speciesHits.length) {
        const seenPaths = new Set();
        const merged = [];
        for (const e of substringHits) {
            if (!seenPaths.has(e.path)) { seenPaths.add(e.path); merged.push(e); }
        }
        for (const e of speciesHits) {
            if (!seenPaths.has(e.path)) { seenPaths.add(e.path); merged.push(e); }
        }
        const reasonParts = [];
        if (substringHits.length) reasonParts.push("substring");
        if (speciesHits.length)   reasonParts.push(`species:${creatureToken}`);
        return {
            matches: _preferFamilyFolder(merged, actorFamily),
            reason: reasonParts.join("+"),
        };
    }

    // 6. Family-folder last-ditch — actor has a known family but no
    //    name-based match landed (e.g. "Hobgoblin Iron Shadow" with no
    //    file named that). Scan the index for ANY entry whose path lives
    //    inside the actor's family folder. Returns those as a "family"
    //    reason so the chooser can show them. Only fires when family is
    //    detected — otherwise we just return empty.
    if (actorFamily) {
        const familyOnly = _index.all.filter(e => e.familyFolder === actorFamily);
        if (familyOnly.length) return { matches: familyOnly.slice(), reason: "family" };
    }

    return { matches: [], reason: "none" };
}

/** Is this image path already inside one of the user's folders? */
function _imageIsInUserFolders(imgPath) {
    if (!imgPath) return false;
    let folders;
    try { folders = game.settings.get(MODULE_ID, "tokenArtFolders") ?? []; }
    catch (_) { return false; }
    return folders.some(f => f && imgPath.startsWith(f));
}

// ─── Path-integrity helpers (v1.0.3) ───────────────────────────────────────
// A token whose image path startsWith a configured folder LOOKS like our art,
// but the file can still be gone (folder renamed, file moved/deleted) — in
// which case Foundry shows the Mystery Man. These helpers detect dead links
// and the load-time audit repairs them.

/** Does this image path resolve to a real file on the server? (HTTP HEAD) */
async function _fileExists(path) {
    if (!path) return false;
    try {
        const route = foundry.utils.getRoute(path);
        const r = await fetch(route, { method: "HEAD" });
        return r.ok;
    } catch (_) { return false; }
}

/** Last path segment — "NPCs/goblin/Bugbear-Warrior-11.png" → "Bugbear-Warrior-11.png". */
function _basename(p) { return String(p ?? "").split("/").pop() ?? ""; }

/** Evenly-spaced sample of up to n items (no RNG — deterministic). */
function _sampleArray(arr, n) {
    if (arr.length <= n) return arr.slice();
    const step = Math.max(1, Math.floor(arr.length / n));
    const out = [];
    for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
    return out;
}

/** Run an async fn over items with a bounded concurrency. */
async function _batchedForEach(items, concurrency, fn) {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(fn));
    }
}

/**
 * Load-time path-integrity pass. RAW of Johnny's request: "when I loaded the
 * world it should have checked the paths." Two stages:
 *
 *   1. Cache-staleness check — the index is loaded from a cache keyed on the
 *      top-level folder LIST, so renaming a SUBfolder (GOBLINOIDS → goblin)
 *      doesn't invalidate it. We sample a handful of indexed files; if a real
 *      fraction are missing, the cache is stale → rescan fresh.
 *   2. Token repair — scan every actor's prototype token + the current scene's
 *      placed tokens for images that should be folder art but no longer resolve.
 *      Repair each: FIRST look for the same filename elsewhere in the current
 *      folders (the file just moved → exact curated variant preserved); if it's
 *      truly gone, re-match by the actor's name and take the best available.
 *
 * Silent by design (GM chose auto-repair) with a one-line summary toast.
 * Gated by `tokenArtEnabled` + `tokenArtRepairOnLoad` (default ON).
 *
 * @returns {Promise<{checked:number, dead:number, repaired:number, unresolved:number}>}
 */
export async function auditAndRepairTokenPaths({ silent = false } = {}) {
    const result = { checked: 0, dead: 0, repaired: 0, unresolved: 0 };
    if (!game.user?.isGM) return result;
    try { if (!game.settings.get(MODULE_ID, "tokenArtEnabled")) return result; } catch (_) {}
    try { if (game.settings.get(MODULE_ID, "tokenArtRepairOnLoad") === false) return result; } catch (_) {}

    // Track whether we've already paid for one fresh (non-cache) rescan so we
    // never scan the whole folder tree twice in a single audit.
    let freshIndex = false;

    // ── Stage 1: detect a stale cache and rescan fresh if needed ──
    try {
        if (_index.ready && _index.all.length) {
            const sample = _sampleArray(_index.all, 15);
            let missing = 0;
            await _batchedForEach(sample, 8, async (e) => { if (!(await _fileExists(e.path))) missing++; });
            if (missing >= Math.ceil(sample.length * 0.2)) {
                console.log(`${TAG} | Cache looks stale (${missing}/${sample.length} sampled files missing) — rescanning fresh.`);
                await rebuildTokenArtIndex({ useCache: false, silent: true });
                freshIndex = true;
            }
        }
    } catch (err) { console.warn(`${TAG} | Cache-staleness check failed (non-fatal):`, err); }

    // ── Stage 2: gather candidate folder-art images (prototype + scene) ──
    const targets = [];
    for (const actor of game.actors ?? []) {
        const img = actor.prototypeToken?.texture?.src ?? "";
        if (_imageIsInUserFolders(img)) targets.push({ isProto: true, actor, name: actor.name, img });
    }
    for (const tok of canvas.scene?.tokens ?? []) {
        const img = tok.texture?.src ?? "";
        if (_imageIsInUserFolders(img)) targets.push({ isProto: false, tokenDoc: tok, actor: tok.actor, name: tok.name ?? tok.actor?.name, img });
    }
    result.checked = targets.length;
    if (!targets.length) return result;

    // Existence-check unique paths (HTTP, batched).
    const uniquePaths = [...new Set(targets.map(t => t.img))];
    const deadSet = new Set();
    await _batchedForEach(uniquePaths, 8, async (p) => { if (!(await _fileExists(p))) deadSet.add(p); });
    const dead = targets.filter(t => deadSet.has(t.img));
    result.dead = dead.length;
    if (!dead.length) return result;

    // Dead links exist → make sure the index is fresh before re-matching, but
    // skip if Stage 1 already rescanned (don't scan the tree twice).
    if (!freshIndex) {
        try { await rebuildTokenArtIndex({ useCache: false, silent: true }); freshIndex = true; }
        catch (err) { console.warn(`${TAG} | Pre-repair rescan failed:`, err); }
    }

    // Same-filename lookup (file moved → preserve the exact curated variant).
    const byBasename = new Map();
    for (const e of _index.all) {
        const bn = _basename(e.path).toLowerCase();
        if (!byBasename.has(bn)) byBasename.set(bn, e);
    }

    for (const t of dead) {
        let entry = byBasename.get(_basename(t.img).toLowerCase());
        if (!entry) {
            // Exact file gone — re-match by the actor's name, take the best.
            try { entry = _findMatches(t.actor?.name ?? t.name ?? "").matches?.[0] ?? null; }
            catch (_) { entry = null; }
        }
        if (!entry) { result.unresolved++; continue; }
        try {
            if (t.isProto) await t.actor.update({ "prototypeToken.texture.src": entry.path }, { aceTokenArtRepair: true });
            else           await t.tokenDoc.update({ "texture.src": entry.path }, { aceTokenArtRepair: true });
            result.repaired++;
        } catch (err) {
            console.warn(`${TAG} | Repair failed for "${t.name}":`, err);
            result.unresolved++;
        }
    }

    console.log(`${TAG} | Path audit: ${result.checked} folder-art images, ${result.dead} dead, ${result.repaired} repaired, ${result.unresolved} unresolved.`);
    if (!silent && (result.repaired || result.unresolved)) {
        const tail = result.unresolved ? ` (${result.unresolved} couldn't be matched — art not found in your folders)` : "";
        ui.notifications?.info(`ACE: Token Art repaired ${result.repaired} broken image path${result.repaired === 1 ? "" : "s"} after folder changes${tail}.`);
    }
    return result;
}

// ─── Recent-choices memory (so repeated drops pre-highlight last pick) ─────

function _getRecentChoices() {
    try { return game.settings.get(MODULE_ID, "tokenArtRecentChoices") ?? {}; }
    catch (_) { return {}; }
}

async function _setRecentChoice(actorName, path) {
    if (!game.user.isGM) return;
    const key = (actorName || "").toLowerCase().trim();
    if (!key) return;
    const recent = _getRecentChoices();
    recent[key] = path;
    try { await game.settings.set(MODULE_ID, "tokenArtRecentChoices", recent); } catch (_) {}
}

// ─── Token swap (also handles auto-rename if enabled) ──────────────────────

async function _applyArt(tokenDoc, entry, { renameSuffix = null } = {}) {
    if (!tokenDoc?.update) return;
    const update = { "texture.src": entry.path };
    // Auto-rename only when caller passes a non-null renameSuffix AND the
    // tokenDoc currently has the BASE name (so we don't clobber a hand-picked
    // name like "Strahd").
    const autoRename = (() => {
        try { return !!game.settings.get(MODULE_ID, "tokenArtAutoRename"); }
        catch (_) { return false; }
    })();
    if (autoRename) {
        // ⚠️🔴 READ THE ART, NOT JUST THE FOLDER IT CAME FROM.
        //
        // `art-descriptor.mjs` was written on 2026-08-08 for exactly this and
        // then never imported by anything - 212 finished lines sitting in the
        // module doing nothing. Johnny asked for it twice:
        //
        //   "I'm really tired of seeing golem one, golem two... but I definitely
        //    need to tell the difference between which goblin is what, and so
        //    did the players."
        //
        // His art already says what each one is. `Goblin_Archer_Bow_03` is a
        // Goblin Archer; `Drow_Matron_Mother_Rod` is a Drow Matron Mother. "I
        // shoot the bomber first" is a sentence a person says at a table.
        // "I shoot Goblin 4" is inventory management.
        //
        // ⚠️ THE FILENAME WINS, THE SUFFIX IS THE FALLBACK. The descriptor
        // returns null when the art says nothing useful, and only then do we
        // fall back to the caller's variant suffix - so a tidy library gets real
        // names and an untidy one behaves exactly as it did before.
        let newName = null;
        try {
            newName = tokenNameFromArt(entry.path, tokenDoc.name);
        } catch (err) {
            console.warn(`${TAG} | could not read a name out of "${entry?.path}":`, err);
        }
        if (!newName && renameSuffix) newName = `${tokenDoc.name} ${renameSuffix}`.trim();
        // ⚠️ NEVER CLOBBER A NAME A PERSON CHOSE. Only rename while the token
        // still carries the plain creature name; "Strahd" stays "Strahd".
        if (newName && newName !== tokenDoc.name) update.name = newName;
    }
    try { await tokenDoc.update(update); }
    catch (err) { console.warn(`${TAG} | Token update failed:`, err); }
}

// ─── Inline floating chooser ───────────────────────────────────────────────

function _dismissActiveChooser() {
    if (_activeChooser?.parentNode) {
        try { _activeChooser.parentNode.removeChild(_activeChooser); } catch (_) {}
    }
    _activeChooser = null;
}

// Maximum thumbnails to surface in the chooser at once. Above this, the
// chooser truncates with a "showing top N of M" note. v0.7.21: bumped
// from 15 → 50 because GMs with curated variant collections (e.g. 20+
// goblins) were getting silently truncated to 15. Per Johnny 2026-06-09.
const CHOOSER_MAX_DISPLAYED = 50;

/**
 * Pop a lightweight thumbnail chooser near the placed token. Resolves with
 * the chosen Entry, or null if dismissed without a choice (in which case the
 * pre-highlighted variant is used as the default).
 */
function _showChooser(tokenDoc, matches, { actorName } = {}) {
    // Cap displayed matches — for "Goblin" with 425 indexed files, dumping
    // them all on screen is unusable. Prefer family-folder + recent-choice
    // priority, then take the first N.
    const recent = _getRecentChoices();
    const lastPath = recent[(actorName || "").toLowerCase().trim()] ?? null;
    const truncated = matches.length > CHOOSER_MAX_DISPLAYED;
    let prioritized = matches;
    if (truncated) {
        // Put the most-recent-chosen first (if it's in the set), then
        // family-folder entries, then everything else. Cap to N.
        const recentEntry = matches.find(m => m.path === lastPath);
        const family = matches.filter(m => m.familyFolder && m !== recentEntry);
        const rest   = matches.filter(m => !m.familyFolder && m !== recentEntry);
        prioritized = [
            ...(recentEntry ? [recentEntry] : []),
            ...family,
            ...rest,
        ].slice(0, CHOOSER_MAX_DISPLAYED);
    }
    const totalCount = matches.length;
    matches = prioritized;

    return new Promise((resolve) => {
        _dismissActiveChooser();

        // Resolve screen position from token's canvas position
        const placed = canvas?.tokens?.placeables?.find(t => t.id === tokenDoc.id);
        let left = window.innerWidth / 2 - 220, top = window.innerHeight / 2 - 140;
        if (placed && canvas?.stage) {
            try {
                const worldX = placed.center?.x ?? (placed.x + placed.w / 2);
                const worldY = placed.center?.y ?? (placed.y + placed.h / 2);
                const screen = canvas.stage.toGlobal({ x: worldX, y: worldY });
                const rect = canvas.app.view.getBoundingClientRect();
                left = rect.left + screen.x - 220; // center the panel on the token
                top  = rect.top + screen.y - 240;  // float above the token
                // Keep on-screen
                left = Math.max(8, Math.min(left, window.innerWidth - 460));
                top  = Math.max(8, Math.min(top,  window.innerHeight - 280));
            } catch (_) { /* fallback to center */ }
        }

        // Determine highlight index from recent-choices memory.
        // v0.7.21: previously used `isFirstTimePick` to disable the auto-pick
        // timer for never-seen creatures. The auto-pick timer is gone entirely
        // now, so this flag isn't needed — every pick is explicit.
        let highlightIdx = matches.findIndex(m => m.path === lastPath);
        if (highlightIdx < 0) highlightIdx = 0;

        // Build DOM
        const root = document.createElement("div");
        root.className = "ace-token-art-chooser";
        root.style.left = `${left}px`;
        root.style.top  = `${top}px`;
        root.tabIndex = 0;

        const header = document.createElement("div");
        header.className = "ace-tap-header";
        const truncNote = truncated
            ? ` <span class="ace-tap-hint" style="color:#d4af37;">(showing top ${matches.length} of ${totalCount})</span>`
            : "";
        header.innerHTML = `<i class="fas fa-image"></i> <strong>${actorName ?? "Token"}</strong> — pick variant${truncNote} <span class="ace-tap-hint">(click • Enter • 1-9 • R random • Esc)</span>`;
        root.appendChild(header);

        // Derive a useful label per match: prefer explicit displayVariant;
        // otherwise compute the difference between the actor name and the
        // file's base/full name. So actor "Goblin" matching file "Goblin
        // Boss.webp" (which indexed as base="Goblin Boss" variant=null)
        // shows "Boss" as the label, not the unhelpful "Base."
        const actorLower = String(actorName ?? "").toLowerCase().trim();
        const cleanedLower = _stripActorNameNoise(actorLower) || actorLower;
        const labelFor = (m) => {
            if (m.displayVariant) return m.displayVariant;
            // Strip the actor name (cleaned) from the front of the file's
            // base/full name. What remains is the variant in its display
            // capitalization.
            const tryStrip = (display) => {
                const lower = display.toLowerCase();
                if (lower.startsWith(cleanedLower + " ")) {
                    return display.slice(cleanedLower.length).trim();
                }
                return null;
            };
            return tryStrip(m.displayBase)
                ?? tryStrip(m.fullName)
                ?? "Base";
        };

        const grid = document.createElement("div");
        grid.className = "ace-tap-grid";
        matches.forEach((m, i) => {
            const thumb = document.createElement("div");
            thumb.className = "ace-tap-thumb" + (i === highlightIdx ? " is-highlight" : "");
            thumb.dataset.idx = String(i);
            thumb.tabIndex = 0;
            const label = labelFor(m);
            thumb.innerHTML = `
                <img src="${m.path}" alt="${m.displayBase}${m.displayVariant ? " — " + m.displayVariant : ""}" />
                <div class="ace-tap-thumb-label">${label}</div>
                ${i < 9 ? `<div class="ace-tap-thumb-key">${i + 1}</div>` : ""}
            `;
            thumb.addEventListener("click", (ev) => {
                ev.stopPropagation();
                finish(m);
            });
            thumb.addEventListener("mouseenter", () => {
                grid.querySelectorAll(".ace-tap-thumb").forEach(t => t.classList.remove("is-highlight"));
                thumb.classList.add("is-highlight");
                highlightIdx = i;
            });
            grid.appendChild(thumb);
        });
        root.appendChild(grid);

        // Footer — different message depending on first-time vs returning pick
        const footer = document.createElement("div");
        footer.className = "ace-tap-footer";
        root.appendChild(footer);

        document.body.appendChild(root);
        _activeChooser = root;
        root.focus();

        let settled = false;
        // v0.7.21: countdown timer REMOVED entirely. Per Johnny 2026-06-09 —
        // "I don't want a timer on it either. I don't want it saying, 'okay,
        // you got to pick one of these, or else it's just gonna pick one for
        // me.'" Chooser now waits indefinitely for an explicit pick
        // (click / Enter / 1-9 / R / Escape). No auto-pick.
        const updateFooter = () => {
            const variantLabel = labelFor(matches[highlightIdx] ?? {});
            footer.textContent = `Highlighted: "${variantLabel}" — click or press Enter to use, R for random, Esc/click-outside to accept highlight.`;
        };

        const finish = (entry) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(entry ?? matches[highlightIdx] ?? matches[0] ?? null);
        };

        const cleanup = () => {
            // v0.7.21: tickId/setInterval removed — no countdown timer to clear.
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("mousedown", onOutsideClick, true);
            _dismissActiveChooser();
        };

        const onKey = (e) => {
            if (e.key === "Enter")            { e.preventDefault(); e.stopPropagation(); finish(matches[highlightIdx]); }
            else if (e.key === "Escape")      { e.preventDefault(); e.stopPropagation(); finish(matches[highlightIdx]); }
            else if (e.key.toLowerCase() === "r") {
                e.preventDefault(); e.stopPropagation();
                const random = matches[Math.floor(Math.random() * matches.length)];
                finish(random);
            }
            else if (/^[1-9]$/.test(e.key)) {
                const idx = parseInt(e.key, 10) - 1;
                if (matches[idx]) { e.preventDefault(); e.stopPropagation(); finish(matches[idx]); }
            }
            else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                let next = highlightIdx;
                if (e.key === "ArrowLeft" || e.key === "ArrowUp")    next = Math.max(0, highlightIdx - 1);
                else                                                  next = Math.min(matches.length - 1, highlightIdx + 1);
                highlightIdx = next;
                grid.querySelectorAll(".ace-tap-thumb").forEach((t, i) =>
                    t.classList.toggle("is-highlight", i === highlightIdx));
                updateFooter();
            }
        };
        document.addEventListener("keydown", onKey, true);

        const onOutsideClick = (e) => {
            if (!root.contains(e.target)) finish(matches[highlightIdx]);
        };
        document.addEventListener("mousedown", onOutsideClick, true);

        // v0.7.21: mouseenter/mouseleave pause logic + setInterval countdown
        // REMOVED. No timer means no need to pause/resume. The chooser just
        // sits there waiting for the GM to pick. (Audit 2026-06-09.)

        // Show the initial footer
        updateFooter();
    });
}

// ─── Bio-pipeline detection + wait helpers ─────────────────────────────────
//
// The chooser fires immediately when bio is OFF, and waits up to 30s when
// bio is ON. After the wait, we read the assigned faction role to refine
// the search ("Goblin" + "Archer" → "Goblin Archer").

const NO_RENAME_TYPES = new Set(["beast", "ooze", "plant", "swarm"]);

/** Will the ACE Engine bio pipeline process this token on drop? */
async function _shouldWaitForBio(tokenDoc) {
    try {
        // ACE Engine module not installed → no bio pipeline
        if (!game.modules.get("ace-engine")?.active) return false;
        // Bio generation explicitly off
        const bioEnabled = game.settings.get("ace-engine", "autoGenerateBio") !== false;
        if (!bioEnabled) return false;
        // ⚠️ TIERS THAT WRITE NOTHING ON DROP — DO NOT WAIT FOR THEM (2026-08-07).
        // This asks "is the engine going to rename / role-tag this token, so I
        // should hold the art chooser until it has?" Only "off" used to count as
        // no. ace-engine 1.7.52 added "silent" — the new DEFAULT — where a drop
        // deliberately writes no bio at all and identity is created later, when
        // a player actually talks to the creature.
        //
        // Left unhandled, every silent drop parked the art chooser for the full
        // 30-second wait on a bio that was never coming. "faction-only" still
        // belongs in the waiting group: it skips the bio but DOES assign the
        // faction role this engine reads to refine its search.
        const tier = String(game.settings.get("ace-engine", "tokenDropAI") ?? "silent");
        if (tier === "off" || tier === "silent") return false;
        // Non-sentient creatures: bio runs but produces no rename / role
        const creatureType = String(tokenDoc.actor?.system?.details?.type?.value ?? "").toLowerCase();
        if (NO_RENAME_TYPES.has(creatureType)) return false;

        // ── Wait detection — was: skip-if-ever-generated; now: wait-if-in-flight ──
        // v0.7.21: pass tokenDoc to isBioInFlight so the engine's synchronous
        // in-memory tracker (_inFlightTokenIds) closes the race window between
        // bio-generator's addToBioQueue and its async setFlag commit.
        // (Audit-mandated 2026-06-08 — Grok pre-launch audit, Critical #4.)
        //
        // Wait if a bio is CURRENTLY in-flight (engine's queue knows about it),
        // OR if the bio has never been generated. Cross-module staleness-safe:
        // prefer the engine API's `isBioInFlight()` which respects the 5-minute
        // staleness cutoff (so a crash-orphaned flag doesn't block art forever).
        // Falls back to the raw boolean if engine didn't expose its API.
        const engineApi = game.modules?.get?.("ace-engine")?.api;
        const inFlight = typeof engineApi?.isBioInFlight === "function"
            ? engineApi.isBioInFlight(tokenDoc.actor, tokenDoc)
            : !!tokenDoc.actor?.getFlag?.("ace-engine", "bioInFlight");
        const everGenerated = !!tokenDoc.actor?.getFlag?.("ace-engine", "bioGenerated");
        if (inFlight) return true;
        if (!everGenerated) return true;

        // ── Last-resort retry for the async-flag race ──
        // If we got inFlight=false but bio-generator's queue hook hasn't yet
        // fired for this token, retry ONCE after a brief delay. Belt+suspenders
        // — the sync _inFlightTokenIds check should already catch this, but on
        // older engine versions that lack the sync set, this retry covers the
        // gap. Capped at one retry so we don't hang the chooser indefinitely.
        await new Promise(r => setTimeout(r, 120));
        const inFlight2 = typeof engineApi?.isBioInFlight === "function"
            ? engineApi.isBioInFlight(tokenDoc.actor, tokenDoc)
            : !!tokenDoc.actor?.getFlag?.("ace-engine", "bioInFlight");
        if (inFlight2) return true;

        // Ever generated AND not in-flight: bio is done, no need to wait
        return false;
    } catch (_) {
        return false;  // any error → don't block, fire immediately
    }
}

/**
 * Wait until ACE Engine's bio + faction pipeline fires its completion
 * hook for THIS token. No hard timeout — the GM can spend 30 seconds or
 * 30 minutes picking a faction in the Customize dialog, the chooser
 * patiently waits. After 2s a toast appears so the GM knows the chooser
 * is paused on purpose.
 *
 * Completion signals (any one wins):
 *   1. `ace-engine.bioComplete` Hook fires for this token   ← primary
 *   2. `flags.ace-engine.bioGenerated` becomes true         ← fallback
 *   3. the token is deleted (GM cancels)                    ← abort
 * There is NO time cutoff — the chooser waits indefinitely (Johnny,
 * 2026-06-09). The only way out is the bio finishing or deleting the token.
 */
async function _waitForBio(tokenDoc) {
    // v0.7.21: NO HARD CUTOFF. Per Johnny 2026-06-09 — the GM takes as long
    // as they take to pick the faction in the NPC Identity Dialog, and the
    // chooser must NOT auto-proceed with stale data. Previously the 60s
    // cutoff fired while the GM was mid-dialog, then token-art would show a
    // generic non-faction-aware variant. Wait indefinitely for either the
    // bioComplete hook or the bioGenerated flag.
    //
    // Safety net: if the user genuinely wants to cancel (e.g. AI provider
    // is down), they delete the token. There's no auto-proceed.
    const POLL_INTERVAL_MS = 500;
    const TOAST_DELAY_MS = 2000;
    const t0 = Date.now();

    let waitToast = null;
    const tokenId = tokenDoc.id;

    // Promise that resolves when the bioComplete hook fires for our token.
    let hookResolve;
    const hookPromise = new Promise(resolve => { hookResolve = resolve; });
    const hookId = Hooks.on("ace-engine.bioComplete", (data) => {
        try {
            if (data?.tokenDoc?.id === tokenId || data?.actor?.id === tokenDoc.actor?.id) {
                hookResolve("hook");
            }
        } catch (_) { /* non-fatal */ }
    });

    try {
        // Race the hook against a polling loop (no time cap — runs until
        // the flag flips OR the hook fires, whichever first).
        const pollPromise = (async () => {
            while (true) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                if (tokenDoc.actor?.getFlag?.("ace-engine", "bioGenerated")) return "flag";
                // If the token gets deleted while we wait, bail
                if (!tokenDoc.parent || !canvas.scene?.tokens?.get?.(tokenId)) return "token-deleted";
            }
        })();

        // Toast after 2s of waiting so the GM knows we're waiting on purpose
        const toastTimer = setTimeout(() => {
            try {
                waitToast = ui.notifications?.info?.(
                    `ACE: Token Art — waiting for bio + faction setup to finish before showing variants… (no time limit)`,
                    { permanent: true }
                );
            } catch (_) { /* non-fatal */ }
        }, TOAST_DELAY_MS);

        const winner = await Promise.race([hookPromise, pollPromise]);
        clearTimeout(toastTimer);

        const elapsed = Date.now() - t0;
        if (winner === "token-deleted") {
            console.log(`${TAG} | Bio wait aborted after ${elapsed}ms — token was deleted.`);
        } else {
            console.log(`${TAG} | Bio wait complete in ${elapsed}ms via ${winner}.`);
        }
    } finally {
        Hooks.off("ace-engine.bioComplete", hookId);
        try { waitToast?.remove?.(); } catch (_) { /* non-fatal */ }
    }
}

// ─── createToken hook handler ──────────────────────────────────────────────

async function _onTokenCreated(tokenDoc, options, userId) {
    if (!game.user.isGM) return;
    if (userId !== game.user.id) return;
    let enabled = true;
    try { enabled = !!game.settings.get(MODULE_ID, "tokenArtEnabled"); } catch (_) {}
    if (!enabled) return;

    const actor = tokenDoc.actor;
    if (!actor) return;

    // ── Skip player characters / party members entirely ──────────────────
    // PCs have their own portraits + bios; the auto-chooser and the bio-wait
    // must NEVER run on the party. A scene full of PCs was triggering a
    // "waiting for bio" popup per token AND re-matching their art to other
    // same-named tokens (e.g. "King" → some other King). The GM can still
    // re-pick a PC's art by hand from the token HUD. (2026-06-28)
    if (actor.hasPlayerOwner || actor.type === "character") {
        console.log(`${TAG} | "${actor.name}" is a player character — skipping auto token-art + bio-wait.`);
        return;
    }

    // Skip flag — actor explicitly opted out
    try {
        if (actor.getFlag(MODULE_ID, "skipAutoArt")) return;
    } catch (_) {}

    // Already user art? — but VERIFY the file actually exists. A renamed,
    // moved, or deleted folder leaves a path that still startsWith a configured
    // folder yet 404s (shows the Mystery Man). That is NOT "already good" — fall
    // through and re-match to self-heal. And when the Always-Choose setting is
    // on, re-show the chooser even for valid art so the GM can re-pick during a
    // curation pass. (v1.0.3)
    const currentImg = tokenDoc.texture?.src ?? "";
    let alwaysChoose = false;
    try { alwaysChoose = !!game.settings.get(MODULE_ID, "tokenArtAlwaysChoose"); } catch (_) {}
    if (_imageIsInUserFolders(currentImg)) {
        const exists = await _fileExists(currentImg);
        if (exists && !alwaysChoose) {
            console.log(`${TAG} | "${actor.name}" already uses user-folder art (${currentImg}) — leaving alone.`);
            return;
        }
        console.log(exists
            ? `${TAG} | "${actor.name}" has valid folder art but Always-Choose is ON — re-showing chooser.`
            : `${TAG} | "${actor.name}" image path is DEAD (${currentImg}) — re-matching to self-heal.`);
    }

    // Wait for index to be ready (build it if not)
    if (!_index.ready) {
        try { await rebuildTokenArtIndex(); } catch (err) { console.warn(`${TAG} | Initial index build failed:`, err); }
    }

    // ── Smart wait for ACE Engine's bio + faction pipeline ──
    // Two-part logic:
    //   1. _shouldWaitForBio: only wait if bio is actually going to run
    //      for this token (setting on, tier !== off, creature is sentient).
    //      Skips the wait entirely otherwise — instant chooser, no
    //      lag for users who don't have the bio system enabled.
    //   2. _waitForBio: polls actor.bioGenerated flag every 500ms with
    //      NO time cutoff — waits indefinitely (cancel by deleting the
    //      token). Posts a "waiting…" notification after 2s so the GM
    //      knows what's happening.
    //
    // After the wait, build the search string from the ORIGINAL creature
    // name (captured before the wait) plus the faction-assigned role flag
    // (e.g. "Goblin" + "Archer" = "Goblin Archer"). This way bio renaming
    // the token to "Gronk" doesn't break art matching — we still search
    // for art keyed on the species, with role-narrowing for the variant.
    // Species tag first (ACE QOL stamps the true creature identity on every NPC
    // token at drop — survives ANY later rename, flavor, or even a manual sheet
    // rename), sheet name as the fallback for tokens without a stamp or when
    // ACE QOL isn't active. (Johnny's type-not-name architecture call, 2026-07-26.)
    let _speciesName = "";
    try { _speciesName = String(game.aceQol?.speciesOf?.(tokenDoc)?.name ?? "").trim(); } catch (_) { /* qol absent */ }
    const initialActorName = _speciesName || String(tokenDoc.actor?.name ?? tokenDoc.name ?? "");
    if (await _shouldWaitForBio(tokenDoc)) {
        await _waitForBio(tokenDoc);
    }

    // v0.7.21: TWO-PASS search — broad species match first, then RANK the
    // role-narrowed matches at the top. Previously the search was just
    // "Goblin Archer" (narrow), which found exactly 1 file and hid the
    // GM's other 18 goblin variants. Per Johnny 2026-06-09 — "shouldn't
    // it show me every one of them? I've got Goblin Archer, Goblin
    // Warrior, Goblin Hexer, Goblin Boss, Goblin on a Dog..."
    //
    // Strategy:
    //   1. Always search the broad species name (e.g. "Goblin") — gets
    //      all variants in the index (via prefix expansion or family-folder
    //      fallback)
    //   2. If a role is set, ALSO search the narrowed name ("Goblin
    //      Archer") — these become the "preferred" matches
    //   3. Merge: preferred matches at the top, then all remaining broad
    //      matches (de-duped). Chooser shows everything; GM picks.
    let role = "";
    try {
        role = String(tokenDoc.actor?.getFlag?.("ace-engine", "factionRole") ?? "").trim();
    } catch (_) { /* role flag absent */ }

    const broad = _findMatches(initialActorName);
    let matches = broad.matches;
    let reason  = broad.reason;
    console.log(`${TAG} | [DIAG] Broad search "${initialActorName}" → ${broad.matches.length} matches (reason="${broad.reason}")`);

    if (role && !initialActorName.toLowerCase().includes(role.toLowerCase())) {
        const narrowedName = `${initialActorName} ${role}`.trim();
        const narrowed = _findMatches(narrowedName);
        console.log(`${TAG} | [DIAG] Narrowed search "${narrowedName}" → ${narrowed.matches.length} matches (reason="${narrowed.reason}")`);
        if (narrowed.matches?.length) {
            // Preferred (role-matching) first, then broad-only entries (de-duped by path)
            const preferredPaths = new Set(narrowed.matches.map(m => m.path));
            const broadOnly = broad.matches.filter(m => !preferredPaths.has(m.path));
            matches = [...narrowed.matches, ...broadOnly];
            reason  = `${narrowed.reason}+broad`;
            console.log(`${TAG} | [DIAG] Merged: ${narrowed.matches.length} preferred + ${broadOnly.length} broad-only = ${matches.length} total`);
        }
    } else {
        console.log(`${TAG} | [DIAG] No role set (or role already in actor name) — using broad search only`);
    }
    console.log(`${TAG} | [DIAG] Final matches before chooser: ${matches.length} (will display up to ${50} in chooser)`);

    console.log(`${TAG} | "${actor.name}" — current="${currentImg}", matches=${matches.length}, reason="${reason}"`);
    if (matches.length) {
        console.log(`${TAG} | Candidate files:`, matches.map(m => m.path));
    }

    if (matches.length === 0) {
        // Toast — once per actor name per session to avoid spam.
        // Also include the prefix-stripped form so the GM knows what
        // filename to drop in (e.g. "Conjured Air Elemental" → tried
        // "air elemental"; drop "Air Elemental.webp" to fix).
        const lower = (actor.name || "").toLowerCase().trim();
        const stripped = _stripModifierPrefixes(lower);
        _notifyMissing(actor.name, stripped !== lower ? stripped : null);
        return;
    }

    // ── Decide: chooser or silent swap? ────────────────────────────
    // Default behavior shows the chooser whenever ANY matches exist, so
    // the GM always has the chance to confirm what art is being applied
    // (and to pick a different variant when there's more than one).
    // The `tokenArtSilentOnSingleMatch` setting flips single-match cases
    // to silent swap — faster, but no visibility into what got applied.
    let silentOnSingle = false;
    try { silentOnSingle = !!game.settings.get(MODULE_ID, "tokenArtSilentOnSingleMatch"); } catch (_) {}

    if (matches.length === 1 && silentOnSingle) {
        const only = matches[0];
        const renameSuffix = (reason === "exact" || !only.displayVariant) ? null : only.displayVariant;
        console.log(`${TAG} | Silent single-match swap → ${only.path}`);
        await _applyArt(tokenDoc, only, { renameSuffix });
        await _setRecentChoice(actor.name, only.path);
        return;
    }

    // Show chooser (handles 1+ matches)
    const chosen = await _showChooser(tokenDoc, matches, { actorName: actor.name });
    if (!chosen) return;
    // Only suggest a rename if the chosen variant differs from the actor's
    // current name (e.g. actor "Goblin" picks "Archer" → "Goblin Archer";
    // actor "Goblin Archer" already exact-matched and never reached here).
    const renameSuffix = chosen.displayVariant && !tokenDoc.name.toLowerCase().includes(chosen.variantLower)
        ? chosen.displayVariant
        : null;
    console.log(`${TAG} | Applied via chooser → ${chosen.path}`);
    await _applyArt(tokenDoc, chosen, { renameSuffix });
    await _setRecentChoice(actor.name, chosen.path);
}

// Throttle "no art" toasts to once per actor name per session so a swarm
// of identical missing-art creatures doesn't drown the screen.
const _missingNotified = new Set();
function _notifyMissing(actorName, strippedName = null) {
    const key = (actorName || "").toLowerCase().trim();
    if (_missingNotified.has(key)) return;
    _missingNotified.add(key);
    const suggestion = strippedName
        ? ` Tried "${strippedName}" too — drop "${strippedName.replace(/\b\w/g, c => c.toUpperCase())}.webp" in your folder, or art for "${actorName}" specifically.`
        : ` Drop "${actorName}.webp" in your folder.`;
    ui.notifications?.warn(`ACE: No token art for "${actorName}".${suggestion} Then run game.modules.get("ace-engine").api.rescanTokenArt() in the console.`);
    console.warn(`${TAG} | No match for "${actorName}"${strippedName ? ` (stripped: "${strippedName}")` : ""}. Add art to one of the configured folders and rescan.`);
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Activate the auto-token-art subsystem. Called from ace-engine.mjs ready hook.
 * GM-only. Idempotent — safe to call more than once.
 */
let _activated = false;
/**
 * Open the token-art chooser for an ACTOR on demand and apply the pick to its
 * PROTOTYPE token, so every token dropped from that actor afterwards uses the
 * chosen art. Wired to the Actors-sidebar right-click menu (Johnny 2026-07-27:
 * "right-click the actor in the sidebar and the token art picker comes up").
 *
 * Reuses the exact same index + chooser the auto-on-drop path uses — no second
 * implementation to drift. Portraits stay untouched; this is TOKEN art only.
 *
 * @param {Actor} actor
 * @returns {Promise<string|null>} the chosen path, or null if cancelled/none
 */
export async function pickTokenArtForActor(actor) {
    if (!actor) return null;
    if (!game.user.isGM) { ui.notifications?.warn("Only the GM can change token art."); return null; }
    try {
        // The index builds in the background at world load; a right-click can
        // easily beat it, so make sure it exists before searching.
        if (!_index.ready) {
            ui.notifications?.info("ACE Token Art: building the art index…");
            await rebuildTokenArtIndex({ silent: true });
        }

        // Search on the SPECIES first (survives any rename), then the sheet
        // name — same precedence the auto-matcher uses.
        let searchName = "";
        try { searchName = String(game.aceQol?.speciesOf?.(actor)?.name ?? "").trim(); } catch (_) { /* qol absent */ }
        if (!searchName) searchName = String(actor.name ?? "").trim();

        const { matches } = _findMatches(searchName);
        if (!matches?.length) {
            ui.notifications?.warn(`ACE Token Art: no art found for "${searchName}". Drop a file named "${searchName}.webp" into a configured folder.`);
            return null;
        }

        // The chooser takes a tokenDoc for its preview; the actor's prototype
        // token is exactly that shape and is what we're editing.
        const chosen = await _showChooser(actor.prototypeToken, matches, { actorName: searchName });
        if (!chosen) return null;   // GM cancelled

        await actor.update({ "prototypeToken.texture.src": chosen.path }, { aceTokenArtRepair: true });
        await _setRecentChoice(searchName, chosen.path);
        ui.notifications?.info(`Token art set for ${actor.name}.`);
        console.log(`${TAG} | Prototype token art set via sidebar for "${actor.name}" → ${chosen.path}`);
        return chosen.path;
    } catch (err) {
        console.error(`${TAG} | pickTokenArtForActor failed:`, err);
        ui.notifications?.error("ACE Token Art: couldn't open the picker — see console.");
        return null;
    }
}

export function activateTokenArtEngine() {
    if (_activated) return Promise.resolve();
    if (!game.user.isGM) return Promise.resolve();
    _activated = true;

    // Build the index in the background after world load so first-spawn
    // doesn't pay the scan cost. createToken will await readiness if needed.
    // Returns the build promise so the ready hook can await it before running
    // the load-time path-integrity audit (which needs a fresh index).
    //
    // ⚠️ THE STARTUP RESCAN (Johnny, 2026-08-06). This used to call
    // rebuildTokenArtIndex() bare, which defaults to useCache:true — so every
    // world load hydrated the saved index and skipped the disk scan entirely.
    // Art added between sessions never appeared until someone opened the
    // folder dialog and hit Rescan by hand. Johnny reasonably assumed a
    // startup rescan already existed; it never did. Now it's a real setting,
    // default ON.
    let _rescanOnStartup = true;
    try { _rescanOnStartup = !!game.settings.get(MODULE_ID, "tokenArtRescanOnStartup"); }
    catch (_) { /* setting not registered yet — fall back to rescanning */ }

    console.log(`${TAG} | Startup index build — ${_rescanOnStartup ? "FULL RESCAN (reading folders from disk)" : "using saved cache (rescan on startup is OFF)"}`);

    const buildPromise = rebuildTokenArtIndex({ useCache: !_rescanOnStartup, silent: true })
        .then(res => {
            console.log(`${TAG} | Startup index ready — ${res?.fileCount ?? 0} files, ${res?.baseCount ?? 0} creatures${res?.fromCache ? " (from cache)" : " (fresh scan)"}.`);
            return res;
        })
        .catch(err => console.warn(`${TAG} | Initial index build failed:`, err));

    // Portraits build alongside, never blocking the token index — the picker
    // only needs them when its Portrait tab is opened.
    rebuildPortraitIndex({ silent: true })
        .catch(err => console.warn(`${TAG} | Initial portrait index build failed:`, err));

    // Prone art the same way. ⚠️ IT HAS TO BE BUILT AT BOOT, not lazily on the
    // tab, because ace-qol asks this index for a creature's prone picture the
    // moment something is knocked down — which can happen before anybody has
    // ever opened the picker.
    rebuildProneIndex({ silent: true })
        .catch(err => console.warn(`${TAG} | Initial prone index build failed:`, err));

    Hooks.on("createToken", _onTokenCreated);

    // ── Actors-sidebar right-click → "Choose Token Art" ────────────────────
    // Both hook names registered for V12/V13 compat (the suite's pattern).
    const _actorArtContext = (_html, options) => {
        try {
            if (!Array.isArray(options)) return;
            if (options.some(o => o.__aceTokenArt)) return;   // never double-add
            options.push({
                name: "Choose Token Art",
                icon: '<i class="fas fa-images"></i>',
                __aceTokenArt: true,
                condition: () => game.user.isGM,
                callback: (li) => {
                    // V13 passes an element; V12 a jQuery wrapper.
                    const el = li instanceof HTMLElement ? li : li?.[0];
                    const id = el?.dataset?.entryId ?? el?.dataset?.documentId;
                    const actor = game.actors.get(id);
                    if (!actor) return ui.notifications?.warn("Couldn't resolve that actor.");
                    pickTokenArtForActor(actor);
                },
            });
        } catch (err) {
            console.warn(`${TAG} | actor context menu injection failed (non-fatal):`, err);
        }
    };
    Hooks.on("getActorDirectoryEntryContext", _actorArtContext);  // V12
    Hooks.on("getActorContextOptions",        _actorArtContext);  // V13

    console.log(`${TAG} | Auto Token Art active.`);
    return buildPromise;
}
