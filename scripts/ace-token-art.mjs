// ─── ACE: Token Art — entry point ──────────────────────────────────────────
//
// Standalone module that scans user-configured folders for token art and
// pops a floating chooser whenever a token drops onto the canvas. No
// dependency on the rest of the ACE Suite — runs entirely on its own.
//
// On first install, looks at the legacy ace-engine namespace for any
// saved settings and migrates them across. So your existing folder list
// + recent-variant choices survive the move.

import {
    activateTokenArtEngine,
    rebuildTokenArtIndex,
    getTokenArtIndex,
    rebuildPortraitIndex,
    getPortraitIndex,
    auditAndRepairTokenPaths,
} from "./token-art-engine.mjs";

export const MODULE_ID = "ace-token-art";
const LEGACY_MODULE_ID = "ace-engine";   // where these settings used to live

// ─── Migration helper ─────────────────────────────────────────────────────

/**
 * Pull saved values out of the legacy ace-engine namespace and copy them
 * into our own. Runs once on first ready after install — guarded so
 * subsequent loads don't re-migrate.
 */
async function _migrateLegacySettings() {
    if (!game.user.isGM) return;
    let already = false;
    try { already = !!game.settings.get(MODULE_ID, "migratedFromAceEngine"); }
    catch (_) { /* not registered yet — shouldn't happen post-init */ }
    if (already) return;

    const keys = [
        "tokenArtEnabled",
        "tokenArtFolders",
        "tokenArtAutoRename",
        "tokenArtRecentChoices",
    ];
    let migratedCount = 0;
    for (const key of keys) {
        try {
            const legacy = game.settings.get(LEGACY_MODULE_ID, key);
            if (legacy === undefined || legacy === null) continue;
            await game.settings.set(MODULE_ID, key, legacy);
            migratedCount++;
        } catch (_) {
            // Legacy setting not registered (ACE Engine version with the
            // pre-extraction code is no longer present). Fine — leave
            // defaults in place.
        }
    }
    try { await game.settings.set(MODULE_ID, "migratedFromAceEngine", true); } catch (_) {}
    if (migratedCount) {
        console.log(`${MODULE_ID} | Migrated ${migratedCount} setting(s) from ace-engine.`);
    }
}

// ─── Folder list: one truth, two views ───────────────────────────────────────
// `tokenArtFolders` (Array) is what the engine reads and has always read.
// `tokenArtFoldersList` (String) is the editable view shown in the settings
// panel. The text writes THROUGH to the array; the array is mirrored back into
// the text on load. Never let the two become independent sources of truth —
// that is how a setting starts lying about what the engine is actually using.
const ACETokenArtFolders = {
    /** Which storage key + rescan each kind of folder list drives. */
    _kinds: {
        token:    { store: "tokenArtFolders",         text: "tokenArtFoldersList",         label: "Token art" },
        portrait: { store: "tokenArtPortraitFolders", text: "tokenArtPortraitFoldersList", label: "Portrait art" },
    },

    /**
     * Seed the text field from the array ONLY when the text is empty (first run
     * after upgrading). After that the text is the GM's own writing — full
     * Windows paths included — and overwriting it with the trimmed array would
     * silently rewrite what they typed every single load.
     */
    async syncTextFromArray() {
        for (const k of Object.values(this._kinds)) {
            try {
                if (String(game.settings.get(MODULE_ID, k.text) ?? "").trim()) continue;
                const arr = game.settings.get(MODULE_ID, k.store);
                const seed = (Array.isArray(arr) ? arr : []).filter(Boolean).join("\n");
                if (seed) await game.settings.set(MODULE_ID, k.text, seed);
            } catch (err) { console.warn(`${MODULE_ID} | ${k.label} folder text seed failed:`, err); }
        }
    },

    /** The text box -> array, then rescan so the change takes effect at once. */
    async applyFromText(raw, kind = "token") {
        const k = this._kinds[kind];
        if (!k) return;
        try {
            // The text holds whatever the GM typed (often a full Windows path);
            // the ARRAY the engine scans must be Data-relative. Trim here, and
            // ONLY here — the visible text is left exactly as written.
            // Split on newlines only: a space belongs to a folder name.
            const folders = String(raw ?? "")
                .split("\n").map(v => _normalizeFolderPath(v)).filter(Boolean);
            const current = game.settings.get(MODULE_ID, k.store);
            if (JSON.stringify(current) === JSON.stringify(folders)) return;

            await game.settings.set(MODULE_ID, k.store, folders);
            if (!folders.length) {
                ui.notifications?.warn(`ACE: Token Art — no ${k.label.toLowerCase()} folders configured; that index is empty.`);
                if (kind === "portrait") await game.modules.get(MODULE_ID)?.api?.rescanPortraitArt?.({ silent: true });
                return;
            }
            ui.notifications?.info(`ACE: Token Art — ${k.label.toLowerCase()} folders updated, rescanning ${folders.length}…`);

            const api = game.modules.get(MODULE_ID)?.api;
            if (kind === "portrait") {
                const res = await api?.rescanPortraitArt?.({ silent: true });
                ui.notifications?.info(`ACE: Token Art — ${(res?.fileCount ?? 0).toLocaleString()} portraits indexed.`);
            } else {
                const res = await api?.rescanTokenArt?.({ useCache: false });
                ui.notifications?.info(
                    `ACE: Token Art — ${(res?.fileCount ?? 0).toLocaleString()} files across ${(res?.baseCount ?? 0).toLocaleString()} creatures.`
                );
            }
        } catch (err) {
            console.error(`${MODULE_ID} | Applying ${k.label.toLowerCase()} folder list failed:`, err);
            ui.notifications?.error(`ACE: Token Art — could not apply that ${k.label.toLowerCase()} folder list; see the console.`);
        }
    },
};

// ─── Folder fields: one row per folder, each with its own browse button ──────
// A String setting renders as ONE line, which crushes a LIST into "NPCs  PCS" —
// unreadable and impossible to tell where one path ends and the next begins.
// Foundry has no native "list of folders" setting, so we rebuild these two
// fields when the settings window renders: a row per folder, each with a folder
// button at the end of its own line. A hidden input carries the joined value
// under the real setting name, so Foundry saves it exactly as before.

/**
 * Accept anything a person might paste and reduce it to a Data-relative path.
 *   D:\FoundryVTT\Data\NPCs\Goblins  ->  NPCs/Goblins
 *   /home/foundry/Data/NPCs          ->  NPCs
 *   NPCs/Goblins                     ->  NPCs/Goblins   (already fine)
 * Only absolute-looking input is trimmed, so a folder genuinely called "Data"
 * inside your Data directory still works.
 */
function _normalizeFolderPath(raw) {
    let p = String(raw ?? "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
    if (!p) return "";
    const absolute = /^[a-z]:\//i.test(p) || p.startsWith("/");
    if (absolute) {
        const i = p.search(/\/data\//i);
        if (i >= 0) p = p.slice(i + "/data/".length);
        else p = p.replace(/^[a-z]:\//i, "").replace(/^\/+/, "");
    }
    return p.replace(/^\/+|\/+$/g, "");
}

Hooks.on("renderSettingsConfig", (_app, html) => {
    try {
        if (!game.user?.isGM) return;
        const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? null);
        if (!root) return;

        for (const key of ["tokenArtFoldersList", "tokenArtPortraitFoldersList"]) {
            const input = root.querySelector(`[name="${MODULE_ID}.${key}"]`);
            if (!input || input.dataset.aceRows) continue;

            const hidden = document.createElement("input");
            hidden.type = "hidden";
            hidden.name = input.name;
            hidden.value = input.value ?? "";
            hidden.dataset.aceRows = "1";

            const wrap = document.createElement("div");
            Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "8px", flex: "1", minWidth: "0" });

            const rows = document.createElement("div");
            Object.assign(rows.style, { display: "flex", flexDirection: "column", gap: "6px" });
            wrap.appendChild(rows);

            // Keep EXACTLY what was typed — full Windows path and all. The
            // trimming happens later, when the engine's array is written.
            // Johnny 2026-08-06: seeing the whole path is the point; people want
            // to know where it came from.
            const sync = () => {
                const vals = [...rows.querySelectorAll("input.ace-folder-row")]
                    .map(i => i.value.trim()).filter(Boolean);
                hidden.value = vals.join("\n");
            };

            const addRow = (value = "", focus = false) => {
                const row = document.createElement("div");
                Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center" });

                const box = document.createElement("input");
                box.type = "text";
                box.className = "ace-folder-row";
                box.value = value;
                box.placeholder = "D:/FoundryVTT/Data/NPCs/Portraits";
                Object.assign(box.style, { flex: "1", minWidth: "0", fontFamily: "monospace", fontSize: "13px" });
                box.addEventListener("input", sync);
                box.addEventListener("change", sync);   // never rewrite what was typed
                row.appendChild(box);

                const pick = document.createElement("button");
                pick.type = "button";
                pick.title = "Browse for a folder";
                pick.setAttribute("aria-label", "Browse for a folder");
                pick.innerHTML = `<i class="fas fa-folder-open"></i>`;
                Object.assign(pick.style, { flex: "0 0 34px", width: "34px", height: "32px", padding: "0", lineHeight: "1" });
                pick.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
                    new FP({
                        type: "folder",
                        current: _normalizeFolderPath(box.value),
                        callback: (path) => { box.value = toFull(_normalizeFolderPath(path)); sync(); },
                    }).browse();
                });
                row.appendChild(pick);

                const del = document.createElement("button");
                del.type = "button";
                del.title = "Remove this folder";
                del.setAttribute("aria-label", "Remove this folder");
                del.innerHTML = `<i class="fas fa-times"></i>`;
                Object.assign(del.style, {
                    flex: "0 0 28px", width: "28px", height: "32px", padding: "0",
                    background: "transparent", border: "none", opacity: "0.6", lineHeight: "1",
                });
                del.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    // Never leave the GM with no row at all — blank the last one instead.
                    if (rows.children.length <= 1) { box.value = ""; sync(); return; }
                    row.remove(); sync();
                });
                row.appendChild(del);

                rows.appendChild(row);
                if (focus) box.focus();
            };

            // ── Where the rows come from ──
            // The TEXT setting is what the GM typed (full paths and all), so it
            // wins when it's intact. But the old single-line <input> saved a
            // multi-folder list as ONE string — "NPCs PCS" — and splitting that
            // on newlines yields a single row containing both folders. The
            // ARRAY the engine scans still has them separated.
            //
            // So: take whichever source has MORE entries. Intact text (equal
            // count) keeps its full paths; corrupted text loses to the array and
            // the rows come out right. Split on newlines only — a space belongs
            // to a folder name like "My Tokens", never separates two paths.
            const storeKey = key === "tokenArtPortraitFoldersList" ? "tokenArtPortraitFolders" : "tokenArtFolders";
            const fromText = String(input.value ?? "").split("\n").map(v => v.trim()).filter(Boolean);
            let fromArray = [];
            try {
                const arr = game.settings.get(MODULE_ID, storeKey);
                if (Array.isArray(arr)) fromArray = arr.map(v => String(v).trim()).filter(Boolean);
            } catch (_) { /* no array — text stands alone */ }
            let existing = (fromText.length && fromText.length >= fromArray.length) ? fromText : fromArray;

            // Show the WHOLE path. A bare "NPCs" tells you nothing about where
            // it actually is; "D:/FoundryVTT/Data/NPCs" does. Anything already
            // absolute is left exactly as written.
            let dataRoot = "";
            try { dataRoot = String(game.settings.get(MODULE_ID, "tokenArtDataRoot") ?? "").trim().replace(/[\\/]+$/, ""); }
            catch (_) { /* setting missing — show relative */ }
            const toFull = (v) => {
                const t = String(v ?? "").trim();
                if (!t || !dataRoot) return t;
                const abs = /^[a-z]:[\\/]/i.test(t) || t.startsWith("/");
                return abs ? t : `${dataRoot}/${t.replace(/^\/+/, "")}`;
            };
            existing = existing.map(toFull);
            if (existing.length) existing.forEach(v => addRow(v));
            else addRow();

            const add = document.createElement("button");
            add.type = "button";
            add.innerHTML = `<i class="fas fa-plus"></i> Add folder`;
            Object.assign(add.style, { fontSize: "13px", padding: "5px 12px", alignSelf: "flex-start" });
            add.addEventListener("click", (ev) => { ev.preventDefault(); addRow("", true); });
            wrap.appendChild(add);

            wrap.appendChild(hidden);
            input.replaceWith(wrap);

            // Foundry prints the hint AFTER the fields, which puts the token-art
            // hint directly above the Portrait heading — it reads as if it
            // belongs to portraits. Move it up under its own label instead.
            const grp = wrap.closest(".form-group");
            const note = grp?.querySelector(":scope > p.notes");
            if (note) wrap.insertBefore(note, wrap.firstChild);

            // Foundry lays settings out as [label | fields] side by side, which
            // squeezes a path row into about half the panel. Stack them instead
            // so the folder rows get the full width — these are long paths.
            const group = wrap.closest(".form-group");
            if (group) {
                Object.assign(group.style, { display: "block" });
                const lbl = group.querySelector(":scope > label");
                if (lbl) Object.assign(lbl.style, {
                    display: "block", width: "100%", flex: "none",
                    marginBottom: "6px", fontWeight: "700",
                });
                const fields = wrap.closest(".form-fields");
                if (fields) Object.assign(fields.style, { display: "block", width: "100%", flex: "none" });
            }
            sync();
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | Folder field upgrade failed (fields still usable):`, err);
    }
});

// ─── Settings registration ────────────────────────────────────────────────

function _registerSettings() {
    const s = (key, def) => game.settings.register(MODULE_ID, key, def);

    // ── "Rescan Folders Now" — a plain BUTTON in the settings panel ──
    // There are too few settings here to justify a pop-up, so the folder list
    // and every toggle live inline below. This menu renders nothing: it runs
    // the rescan and closes immediately, which makes it behave like a button
    // sitting in the settings list rather than another window to navigate.
    try {
        game.settings.registerMenu(MODULE_ID, "rescanNow", {
            name: "Token Art Index",
            label: "Rescan Folders Now",
            hint: "Re-read every scan folder and rebuild the art index right now. You only need this if you added art files while Foundry was already running — folder edits and startup rescan it for you.",
            icon: "fa-solid fa-arrows-rotate",
            restricted: true,
            type: class extends FormApplication {
                static get defaultOptions() {
                    return foundry.utils.mergeObject(super.defaultOptions, {
                        id: "ace-token-art-rescan-now",
                        title: "ACE: Token Art — Rescan",
                        template: null,
                        popOut: false,
                    });
                }
                async _render() {
                    // No form — just do the work and get out of the way.
                    try {
                        const api = game.modules.get(MODULE_ID)?.api;
                        const res = await api?.rescanTokenArt?.({ useCache: false });
                        ui.notifications?.info(
                            `ACE: Token Art — rescan complete: ${(res?.fileCount ?? 0).toLocaleString()} files, ${(res?.baseCount ?? 0).toLocaleString()} creatures.`
                        );
                    } catch (err) {
                        console.error(`${MODULE_ID} | Manual rescan failed:`, err);
                        ui.notifications?.error("ACE: Token Art — rescan failed; see the console.");
                    }
                    this.close({ submit: false });
                }
                async _updateObject() { /* no-op */ }
            },
        });
    } catch (err) {
        console.warn(`${MODULE_ID} | Rescan menu registration failed:`, err);
    }

    // ── The data root, purely so folder rows can show a FULL path ──
    // The browser cannot see where Foundry's Data directory lives on disk, so
    // there is no way to display "D:/FoundryVTT/Data/NPCs" without being told.
    // Purely cosmetic: the engine always scans the Data-relative part.
    s("tokenArtDataRoot", {
        scope: "world",
        name: "Your Foundry Data folder",
        hint: "Shown at the start of every folder row so you can see the whole path. Cosmetic only.",
        type: String,
        default: "D:/FoundryVTT/Data",
        config: true,
    });

    // ── Rescan on startup (Johnny, 2026-08-06) ──
    // This was assumed to exist and never did: the startup build ran with the
    // cache ON, so it loaded the saved index and skipped scanning every time.
    // Default ON — art added between sessions is picked up without touching
    // a single setting.
    s("tokenArtRescanOnStartup", {
        scope: "world",
        name: "Rescan Folders on Startup",
        hint: "When ON (default), every world load re-reads your art folders from disk so newly added files appear immediately. When OFF, the saved index is loaded instantly and new art only appears after a manual rescan — faster to boot, but it goes stale.",
        type: Boolean,
        default: true,
        config: true,
    });

    // ── The folder list, editable inline ──
    // `tokenArtFolders` (below) stays the Array that everything reads; this is
    // the human-editable view of it. One source of truth, written through on
    // change — never two settings drifting apart.
    s("tokenArtFoldersList", {
        scope: "world",
        name: "Token Art Folders",
        hint: "Top-down token images.",
        type: String,
        default: "",
        config: true,
        onChange: (raw) => { ACETokenArtFolders.applyFromText(raw, "token"); },
    });

    // ── Portrait art: a SEPARATE tree, deliberately never mixed in ──
    // Johnny, 2026-08-06. A top-down token makes a terrible portrait and a
    // portrait makes a worse token, so the two indexes never share folders.
    s("tokenArtPortraitFolders", {
        scope: "world",
        config: false,          // storage — edited via the text field below
        type: Array,
        default: [],
    });

    s("tokenArtPortraitFoldersList", {
        scope: "world",
        name: "Portrait Art Folders",
        hint: "Face images for the picker's Portrait tab. Sets the actor's profile picture.",
        type: String,
        default: "",
        config: true,
        onChange: (raw) => { ACETokenArtFolders.applyFromText(raw, "portrait"); },
    });

    s("tokenArtEnabled", {
        scope: "world",
        name: "Enable Auto Token Art",
        hint: "Master switch. When ON, freshly created tokens that don't already use art from your configured folders pop a variant chooser. Tokens whose image is already inside one of your folders are left alone. Defaults to ON — turn off to disable the feature entirely.",
        type: Boolean,
        default: true,
        config: true,
    });

    s("tokenArtFolders", {
        scope: "world",
        config: false,    // edited via the "Configure Folders" menu above
        type: Array,
        default: ["NPCs", "assets/srd5e/img/bestiary/tokens/MM"],
    });

    s("tokenArtAutoRename", {
        scope: "world",
        name: "Auto-Rename Token on Variant Pick",
        hint: "When ON, picking a variant from the chooser (e.g. 'Archer' for a Goblin) auto-renames the token from 'Goblin' to 'Goblin Archer' so the initiative tracker shows which variant is which. Doesn't touch the underlying actor — only the placed token.",
        type: Boolean,
        default: true,
        config: true,
    });

    // NEW behavior in 1.0: the chooser appears whenever ANY matches exist
    // (1 or more), not just 2+. Single-match silent swaps are opt-in via
    // this setting so you always have a chance to confirm/cancel.
    s("tokenArtSilentOnSingleMatch", {
        scope: "world",
        name: "Silent Swap When Only One Match Exists",
        hint: "When ON, single-match cases skip the chooser and silently apply the only matching file. Faster for well-organized folders where each creature has exactly one art file, but you lose the chance to confirm. When OFF (default), the chooser pops up for every match — even a single one — so you can always see and confirm what's being applied.",
        type: Boolean,
        default: false,
        config: true,
    });

    // Curation mode: re-show the chooser even when the token already wears
    // valid folder art, so the GM can deliberately re-pick a variant. Default
    // OFF (most tables want "already good" to mean "leave it"); turn ON during
    // a curation pass where you're assigning a permanent variant per creature.
    s("tokenArtAlwaysChoose", {
        scope: "world",
        name: "Always Show Chooser (even if art is already set)",
        hint: "When ON, dropping a token whose image is already one of your folder variants STILL pops the chooser, so you can re-pick. Useful while you're curating which variant each creature should use. When OFF (default), tokens that already wear valid folder art are left alone.",
        type: Boolean,
        default: false,
        config: true,
    });

    // Load-time path-integrity / self-heal. When ON (default), on world load
    // the engine checks token image paths and repairs any that broke because a
    // folder was renamed/moved/deleted — re-pointing them at the moved file or
    // a fresh match, silently, so you never see a Mystery Man after reorganizing.
    s("tokenArtRepairOnLoad", {
        scope: "world",
        name: "Auto-Repair Broken Art Paths on Load",
        hint: "When ON (default), each time the world loads the engine verifies token art still resolves to real files and silently fixes any that broke when you renamed, moved, or deleted a folder — preferring the same file at its new location so your exact picks survive. A one-line summary tells you how many it fixed. Turn off only if you want stale paths left exactly as-is.",
        type: Boolean,
        default: true,
        config: true,
    });

    s("tokenArtRecentChoices", {
        scope: "world",
        config: false,
        type: Object,
        default: {},
    });

    // Migration sentinel — prevents re-migration on every world load
    s("migratedFromAceEngine", {
        scope: "world",
        config: false,
        type: Boolean,
        default: false,
    });
}

// ─── Hook registration ────────────────────────────────────────────────────

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | init`);
    try { _registerSettings(); }
    catch (err) { console.warn(`${MODULE_ID} | Settings registration failed:`, err); }
});

Hooks.once("ready", async () => {
    if (!game.user.isGM) return;

    // Migrate legacy settings (if any) before the engine boots
    try { await _migrateLegacySettings(); }
    catch (err) { console.warn(`${MODULE_ID} | Legacy migration failed (non-fatal):`, err); }

    // Mirror the stored folder Array into the editable text field, so the
    // settings panel always shows what the engine is actually scanning.
    // Runs BEFORE activation so a first-run empty box gets filled in.
    try { await ACETokenArtFolders.syncTextFromArray(); }
    catch (err) { console.warn(`${MODULE_ID} | Folder text sync failed (non-fatal):`, err); }

    // Activate the engine (await the initial index build so the audit below
    // runs against a ready index).
    try { await activateTokenArtEngine(); }
    catch (err) { console.warn(`${MODULE_ID} | Activation failed:`, err); }

    // Load-time path-integrity / self-heal pass — repair any token art paths
    // that broke since last session (renamed/moved/deleted folders). Silent
    // auto-repair with a one-line summary. Backgrounded so it never delays the
    // ready hook; gated internally by tokenArtRepairOnLoad (default ON).
    auditAndRepairTokenPaths().catch(err =>
        console.warn(`${MODULE_ID} | Path-integrity audit failed (non-fatal):`, err)
    );

    // Expose API
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
        mod.api = {
            /**
             * Rescan configured folders + rebuild the in-memory index.
             * @param {object} [opts]
             * @param {boolean} [opts.useCache=false] — pass true to load
             *   from the cache when folders match instead of rescanning
             *   from disk. Default false because callers of this API
             *   (Rescan button, console) usually want a fresh scan.
             * @param {boolean} [opts.silent=false] — suppress toast UI.
             */
            rescanTokenArt: async (opts = {}) => {
                const useCache = opts.useCache ?? false;
                const silent = opts.silent ?? false;
                const result = await rebuildTokenArtIndex({ useCache, silent });
                if (!silent && !result.fromCache) {
                    ui.notifications?.info(`${MODULE_ID}: Rescanned — ${result.fileCount} files, ${result.baseCount} base names.`);
                }
                return result;
            },
            /** Inspect the current in-memory index (for debugging). */
            getTokenArtIndex,
            /**
             * Re-run the path-integrity / self-heal pass on demand (repairs
             * broken art paths across actors + the current scene). Returns
             * { checked, dead, repaired, unresolved }.
             */
            repairTokenArt: async (opts = {}) => auditAndRepairTokenPaths(opts),
            /** Substring search for "where's my art for X?" debugging. */
            searchTokenArt: (query) => {
                const idx = getTokenArtIndex();
                const q = (query || "").toLowerCase().trim();
                if (!q) return idx.all.slice();
                return idx.all.filter(e =>
                    e.baseLower.includes(q) || e.fullLower.includes(q)
                ).map(e => ({
                    base:     e.displayBase,
                    variant:  e.displayVariant,
                    fullName: e.fullName,
                    path:     e.path,
                }));
            },

            // ── Portraits (separate folders, separate index) ──
            getPortraitIndex,
            /** Rebuild the portrait index from tokenArtPortraitFolders. */
            rescanPortraitArt: async (opts = {}) => rebuildPortraitIndex(opts),
            /** Filename search over portraits; empty query returns them all. */
            searchPortraitArt: (query) => {
                const idx = getPortraitIndex();
                const q = String(query ?? "").toLowerCase().trim();
                if (!q) return idx.all.slice();
                const words = q.split(/\s+/).filter(Boolean);
                const scored = [];
                for (const e of idx.all) {
                    const h = e.fullLower;
                    let score = 0;
                    if (h.includes(q)) score = 100;
                    else if (words.length > 1 && words.every(w => h.includes(w))) score = 60;
                    else if (h.includes(words[0] ?? q)) score = 40;
                    else if (words.some(w => h.includes(w))) score = 20;
                    if (score) scored.push({ e, score });
                }
                scored.sort((a, b) => b.score - a.score);
                return scored.map(s => s.e);
            },
        };
    }
});
