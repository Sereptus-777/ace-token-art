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
    matchMissingArt,
    getProneIndex,
    rebuildProneIndex,
    getPortraitIndex,
    auditAndRepairTokenPaths,
    INDEX_READY_HOOK,
    rankArtForName,
    saveDeferredIndexCache,
} from "./token-art-engine.mjs";
import { TokenScaleWrite } from "./token-scale-write.mjs";

export const MODULE_ID = "ace-token-art";
const LEGACY_MODULE_ID = "ace-engine";   // where these settings used to live

/* ═══════════════════════════════════════════════════════════════════════════
   ONE RESCAN, ALL THREE ROOTS

     His rule, 2026-10-03: "Rescan reads all three roots and does not save until
     every root has reported. A second click while it is running does nothing.
     Show a progress line while it walks. When it finishes, one toast, not red,
     and it goes away on its own."

   ⚠️🔴 WHAT IT USED TO DO, ON ALL FOUR COUNTS. It walked the three in turn and
   the token walk SAVED ITS CACHE the moment it finished, so a window closed
   during the portrait walk left a cache on disk that was only as true as one
   library and was loaded at the next startup as if it were whole. Nothing
   stopped a second click, so two walks of twenty-eight thousand files ran over
   each other. Nothing said it was working. And it finished with a permanent
   toast plus up to three more warnings behind it, which is four things to
   dismiss by hand after a scan that went fine.
   ═══════════════════════════════════════════════════════════════════════════ */

/** The run in flight, or null. A second click reads this and goes home. */
let _rescanInFlight = null;

/**
 * Walk every configured root, then save once.
 * @returns {Promise<object|null>} the counts, or null when a run was already going
 */
export async function rescanAllArt() {
  if (_rescanInFlight) {
    // ⚠️ SAID OUT LOUD, QUIETLY. A click that does nothing and says nothing is
    // indistinguishable from a dead button.
    console.log(`${MODULE_ID} | a rescan is already walking the folders; this click does nothing.`);
    try { ui.notifications?.info("ACE: Token Art — a rescan is already running."); } catch (_) {}
    return null;
  }
  const run = (async () => {
    let line = null;
    try { line = ui.notifications?.info("ACE: Token Art — reading your art folders…", { progress: true }) ?? null; }
    catch (_) { line = null; }
    const say = (pct, message) => {
      try { line?.update?.({ pct, message }); } catch (_) { /* a progress line never stops the walk */ }
    };

    try {
      await ACETokenArtFolders.reconcileFromText();
      const api = game.modules.get(MODULE_ID)?.api;

      const tFolders = game.settings.get(MODULE_ID, "tokenArtFolders") ?? [];
      const pFolders = game.settings.get(MODULE_ID, "tokenArtPortraitFolders") ?? [];
      const rFolders = game.settings.get(MODULE_ID, "tokenArtProneFolders") ?? [];

      // Three walks, one third of the line each, and the counts as they come.
      const leg = (base, label) => ({ dirs, files }) =>
        say(base + Math.min(0.30, (dirs / 1200) * 0.30),
          `ACE: Token Art — ${label}: ${files.toLocaleString()} file(s) in ${dirs.toLocaleString()} folder(s)…`);

      // ⚠️ THE TOKEN WALK HOLDS ITS SAVE. Nothing is written until the other two
      // have reported, so what lands on disk is one whole answer or none.
      const tokenRes    = await api?.rescanTokenArt?.({ useCache: false, silent: true,
        deferSave: true, onProgress: leg(0.00, "tokens") });
      const portraitRes = await api?.rescanPortraitArt?.({ silent: true, onProgress: leg(0.33, "portraits") });
      const proneRes    = await api?.rescanProneArt?.({ silent: true, onProgress: leg(0.66, "dead and prone art") });

      say(0.99, "ACE: Token Art — saving the index…");
      const saved = await api?.saveArtIndexCache?.();

      const counts = {
        token: tokenRes?.fileCount ?? 0, portrait: portraitRes?.fileCount ?? 0,
        prone: proneRes?.fileCount ?? 0, saved: !!saved,
      };
      console.log(`${MODULE_ID} | Rescan complete, and the index was ${saved ? "saved once, after every root reported" : "NOT saved"}.`
        + `\n  Token art (${tFolders.join(", ") || "none"}): ${counts.token} file(s)`
        + `\n  Portraits (${pFolders.join(", ") || "none"}): ${counts.portrait} file(s)`
        + `\n  Dead and prone (${rFolders.join(", ") || "none"}): ${counts.prone} file(s)`);

      /* ⚠️ A ROOT THAT CAME BACK EMPTY IS STILL ONE LINE, NOT A RED ONE. It used
         to raise a permanent warning per empty list, so a man with no portraits
         configured got a red banner he had to clear every single rescan. It is
         on the one line now, in the same words, and it disappears by itself. */
      const empties = [
        tFolders.length && !counts.token ? "tokens" : null,
        pFolders.length && !counts.portrait ? "portraits" : null,
        rFolders.length && !counts.prone ? "dead and prone art" : null,
        !tFolders.length ? "no token folders listed" : null,
        !pFolders.length ? "no portrait folders listed" : null,
        !rFolders.length ? "no dead or prone folders listed" : null,
      ].filter(Boolean);

      say(1, "ACE: Token Art — done.");
      const summary = `ACE: Token Art — ${counts.token.toLocaleString()} tokens, `
        + `${counts.portrait.toLocaleString()} portraits, ${counts.prone.toLocaleString()} dead and prone.`
        + (empties.length ? ` Nothing found for: ${empties.join(", ")}.` : "");
      // ⚠️ ONE TOAST, NOT RED, AND IT GOES AWAY ON ITS OWN: no `permanent`.
      try { ui.notifications?.info(summary); } catch (_) { /* the console has it either way */ }
      return counts;
    } catch (err) {
      console.error(`${MODULE_ID} | the rescan failed partway through, so nothing was saved:`, err);
      try { ui.notifications?.warn("ACE: Token Art — the rescan stopped early; the console says where."); } catch (_) {}
      return null;
    } finally {
      // The line closes whichever way this went.
      try { line?.update?.({ pct: 1 }); } catch (_) {}
      _rescanInFlight = null;
    }
  })();
  _rescanInFlight = run;
  return run;
}


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
    try { await game.settings.set(MODULE_ID, "migratedFromAceEngine", true); } catch (err) { console.warn(`ace-token-art | a set did not save:`, err); }
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
        prone:    { store: "tokenArtProneFolders",    text: "tokenArtProneFoldersList",    label: "Prone art" },
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

    /**
     * TEXT -> ARRAY for every kind, WITHOUT rescanning. The array is a derived
     * cache, never an independent source of truth.
     *
     * ⚠️ WHY THIS EXISTS (2026-08-06). The array was only ever rewritten by the
     * text setting's onChange hook, which fires just when the value CHANGES.
     * Any path that didn't produce a change event — a value written before this
     * wiring existed, a settings save that round-tripped identical text, an
     * array edited directly — left `tokenArtFolders` frozen at its default
     * ["NPCs", "assets/srd5e/img/bestiary/tokens/MM"]. That is EXACTLY the two
     * folders Johnny kept seeing scanned no matter what he listed, and the
     * portrait array sat at its own default of [] so portraits scanned nothing.
     *
     * Every scan now reconciles first, so the engine can only ever scan what
     * the settings panel actually lists.
     *
     * @returns {Promise<{changed: string[]}>} labels of the kinds that moved
     */
    async reconcileFromText() {
        const changed = [];
        for (const [kind, k] of Object.entries(this._kinds)) {
            try {
                const raw = game.settings.get(MODULE_ID, k.text);
                const folders = String(raw ?? "")
                    .split("\n").map(v => _normalizeFolderPath(v)).filter(Boolean);
                const current = game.settings.get(MODULE_ID, k.store);
                // Empty text means "nothing listed" — but only trust that once
                // the text has actually been seeded, or a fresh install would
                // wipe its own sensible defaults on first boot.
                if (!folders.length && !String(raw ?? "").trim()) continue;
                if (JSON.stringify(current) === JSON.stringify(folders)) continue;
                await game.settings.set(MODULE_ID, k.store, folders);
                changed.push(k.label);
                console.log(`${MODULE_ID} | ${k.label} folders reconciled from settings: ${folders.length} folder(s) — ${folders.join(", ") || "(none)"}`);
            } catch (err) {
                console.warn(`${MODULE_ID} | ${k.label} folder reconcile failed:`, err);
            }
        }
        return { changed };
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
            // ⚠️🔴 THIS WAS "PORTRAIT OR ELSE", AND ELSE MEANT TOKEN ART.
            // With a third kind that shape silently rescans the token index
            // whenever a PRONE folder changes, and never rebuilds prone at all:
            // the folder would save, the tab would stay empty, and nothing would
            // say why. Dispatched by kind now, so a fourth cannot repeat it.
            const api = game.modules.get(MODULE_ID)?.api;
            const rescan = {
                portrait: async () => {
                    const res = await api?.rescanPortraitArt?.({ silent: true });
                    return `${(res?.fileCount ?? 0).toLocaleString()} portraits indexed.`;
                },
                prone: async () => {
                    const res = await api?.rescanProneArt?.({ silent: true });
                    return `${(res?.fileCount ?? 0).toLocaleString()} prone images indexed.`;
                },
                token: async () => {
                    const res = await api?.rescanTokenArt?.({ useCache: false });
                    return `${(res?.fileCount ?? 0).toLocaleString()} files across `
                         + `${(res?.baseCount ?? 0).toLocaleString()} creatures.`;
                },
            }[kind] ?? null;

            if (!rescan) {
                console.error(`${MODULE_ID} | "${kind}" has no rescan, so its folder list saved `
                    + `but its index was NOT rebuilt.`);
                return;
            }

            if (!folders.length) {
                ui.notifications?.warn(`ACE: Token Art — no ${k.label.toLowerCase()} folders configured; that index is empty.`);
                await rescan();
                return;
            }
            ui.notifications?.info(`ACE: Token Art — ${k.label.toLowerCase()} folders updated, rescanning ${folders.length}…`);
            ui.notifications?.info(`ACE: Token Art — ${await rescan()}`);
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

        for (const key of ["tokenArtFoldersList", "tokenArtPortraitFoldersList", "tokenArtProneFoldersList"]) {
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
            // ⚠️ A TERNARY THAT ONLY KNEW TWO KINDS. Adding prone through it would
            // have filed every prone folder under token art, silently, and the two
            // lists would have fought on the next save. Keyed off the kinds table so
            // a fourth kind cannot repeat this.
            const storeKey = Object.values(ACETokenArtFolders._kinds)
              .find(k => k.text === key)?.store ?? "tokenArtFolders";
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

    /* ── RESCAN FOLDERS, FIRST IN THE PANEL ──────────────────────────────────
     *
     * ⚠️🔴 HIS RULE, 2026-10-05: "The button used to say Rescan folders and it is
     * gone from that panel. Put it back at the top of that panel, above
     * everything else. Same scan it used to run. Do not build a second one."
     *
     * It went when that menu entry was pointed at the folder window instead,
     * which the window needed and this did not deserve to lose. So it is its own
     * entry again, and it is REGISTERED FIRST, because Foundry draws a module's
     * section in registration order and that is the only way to be at the top.
     *
     * It calls `rescanAllArt`, the one door: the guard against a second walk, the
     * progress line, the held save and the single toast all live in there. There
     * is no second scanner.
     */
    try {
        game.settings.registerMenu(MODULE_ID, "rescanArt", {
            name: "Token Art",
            label: "Rescan folders",
            hint: "Walk the token, portrait and dead-or-prone folders again and rebuild the index from "
                + "what is on disk now. Run it after you add or move art.",
            icon: "fa-solid fa-arrows-rotate",
            restricted: true,
            type: class extends FormApplication {
                static get defaultOptions() {
                    return foundry.utils.mergeObject(super.defaultOptions, {
                        id: "ace-token-art-rescan-launcher",
                        title: "ACE: Token Art — Rescan",
                        template: null,
                        popOut: false,
                    });
                }
                async _render() {
                    // Nothing of this launcher is ever on screen: it stands down
                    // at once and lets the one scan get on with it.
                    this.close({ submit: false });
                    rescanAllArt().catch(err => {
                        console.error(`${MODULE_ID} | the rescan failed:`, err);
                        ui.notifications?.error("ACE: Token Art — the rescan failed; the console "
                            + "says where.");
                    });
                }
                async _updateObject() { /* no-op */ }
            },
        });
    } catch (err) {
        console.error(`${MODULE_ID} | the Rescan folders button could not be registered:`, err);
    }

    // ── "Configure Folders" — the dialog, finally reachable ──
    //
    // ⚠️🔴 `folder-config-dialog.mjs` is 255 finished lines that nothing
    // imported. Its own header says it "replaces what used to be edit the array
    // setting via console", and until now the console was still the only way in.
    // Johnny, 2026-08-24: "why is that shit in?" - fair. It is a button now.
    try {
        game.settings.registerMenu(MODULE_ID, "folderConfig", {
            name: "Token Art Folders",
            label: "Add or Edit Folders",
            hint: "Pick the folders scanned for token art, browse to them, and rescan without leaving the window.",
            icon: "fa-solid fa-folder-tree",
            restricted: true,
            type: class extends FormApplication {
                static get defaultOptions() {
                    return foundry.utils.mergeObject(super.defaultOptions, {
                        id: "ace-token-art-folder-config-launcher",
                        title: "ACE: Token Art \u2014 Folders",
                        template: null,
                        popOut: false,
                    });
                }
                async _render() {
                    /* ⚠️🔴 THIS BUTTON STOPPED OPENING THE WINDOW. It ran a blind
                       rescan and closed, so the folder rows, the browse buttons
                       and RESCAN NOW went back to being unreachable -- which is
                       the exact fault the comment above this says was fixed, and
                       the hint on the button promises all three. The window is
                       the control; the rescan lives inside it.

                       Loaded here and not at the top of the file: that dialog
                       imports MODULE_ID back out of this one, and a static
                       import both ways is the cycle that kills a module on the
                       way in. */
                    import("./folder-config-dialog.mjs")
                        .then(({ openFolderConfigDialog }) => openFolderConfigDialog())
                        .catch(err => {
                            console.error(`${MODULE_ID} | the folder window could not open:`, err);
                            try {
                                ui.notifications?.error("ACE: Token Art — the folder window could not open; "
                                    + "the console says why.");
                            } catch (_) { /* the console has it either way */ }
                        });
                    // Nothing of this launcher is ever on screen, so it stands
                    // down at once rather than staying open behind the window.
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
        hint: "Top-down token images. Portraits and dead or prone art live in their own lists below, and a walk of one never crosses into another.",
        type: String,
        default: "1_tokens",
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
        default: ["1_portraits"],
    });

    s("tokenArtPortraitFoldersList", {
        scope: "world",
        name: "Portrait Art Folders",
        hint: "Face images for the picker's Portrait tab. Sets the actor's profile picture.",
        type: String,
        default: "1_portraits",
        config: true,
        onChange: (raw) => { ACETokenArtFolders.applyFromText(raw, "portrait"); },
    });

    // ── Prone art: a THIRD tree, for creatures lying down ──
    // Johnny, 2026-09-02. ace-qol swaps a creature's token to this art when it
    // goes prone, and until now the only way to give it one was to drop a
    // correctly named file in a fixed folder and hope the name matched.
    //
    // ⚠️ DEFAULTED TO THE FOLDER HIS ART IS ALREADY IN, so the tab has content
    // the first time he opens it instead of telling him to go configure it.
    s("tokenArtProneFolders", {
        scope: "world",
        config: false,          // storage — edited via the text field below
        type: Array,
        /* ⚠️🔴 HIS ORDER, 2026-10-03: "modules/ace-qol/Assets/Dead stays in the
           module and is checked only after 1_dead-prone." The library he keeps
           comes first and the folder that ships with ACE is the fallback behind
           it, so a picture he has put in his own library always wins over the
           one the module brought.

           ⚠️🔴 AND Assets/Prone IS STILL ON THE LIST, which he did not name.
           It holds eight pictures of people with names — Escher, Izek, Chudd,
           Firaxis, Jeth, Syrax, Vilnius, Virric — and not one of them is in the
           manifest or in 1_dead-prone. Dropping the folder because he did not
           mention it would have taken the prone art off eight named characters
           without a word. It is last, behind both, and it is his to remove. */
        default: ["1_dead-prone", "modules/ace-qol/Assets/Dead", "modules/ace-qol/Assets/Prone"],
    });

    s("tokenArtProneFoldersList", {
        scope: "world",
        name: "Dead and Prone Art Folders",
        hint: "Pictures of creatures lying down or dead, for the picker's Prone tab. ACE QOL swaps a token to this art when it goes prone or dies. The module's own Assets/Dead is checked after your own library.",
        type: String,
        default: "1_dead-prone\nmodules/ace-qol/Assets/Dead\nmodules/ace-qol/Assets/Prone",
        config: true,
        onChange: (raw) => { ACETokenArtFolders.applyFromText(raw, "prone"); },
    });

    /* ⚠️ WHERE A WINDOW'S SIZE IS KEPT (his rule, 2026-10-04: "I want it left
       at the same size next time you open it"). CLIENT scope, because the size
       a window was dragged to belongs to the screen it was dragged on: his
       desktop is a 4090 at full width and the camp laptop is not, and a world
       setting would have one of them fighting the other every rotation. Not on
       the settings panel: it is a memory, not a knob. */
    s("uiSizes", {
        scope: "client",
        config: false,
        type: Object,
        default: {},
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
        // ⚠️ HIS THREE LIBRARIES (2026-10-03). The copies are already made; these
        // are where they live now.
        default: ["1_tokens"],
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
    // Registered at init, before ready has run, so the render hooks it adds are
    // in place for the first token config or HUD of the session.
    try { TokenScaleWrite.register(); }
    catch (err) { console.warn(`${MODULE_ID} | Token scale write registration failed:`, err); }
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

    // …then push the text BACK through to the arrays the engine scans, before
    // the first index build. Seeding alone only fills an empty box; without
    // this second half, a folder list edited at any point when the onChange
    // hook didn't fire stays invisible to every scan, forever. Order matters:
    // seed first (so a fresh install keeps its defaults), reconcile second.
    try { await ACETokenArtFolders.reconcileFromText(); }
    catch (err) { console.warn(`${MODULE_ID} | Folder reconcile failed (non-fatal):`, err); }

    // Activate the engine (await the initial index build so the audit below
    // runs against a ready index).
    try { await activateTokenArtEngine(); }
    catch (err) { console.warn(`${MODULE_ID} | Activation failed:`, err); }

    // ── Take the escape sequences back off his map ──────────────────────
    // ⚠️ FIXING THE DESCRIPTOR DOES NOT FIX THE TOKENS IT ALREADY RENAMED.
    // A rename is persisted in the scene, so names like
    // "Shadow%20dragon% Shadow Dragon (Huge)" stay on the map forever unless
    // something goes and takes them off. Four were standing in front of his
    // players on 2026-08-25. Wrapped in its own try so a failure here can
    // never take the registrations below it down with it.
    try {
      const { sweepEncodedTokenNames } = await import("./name-repair.mjs");
      await sweepEncodedTokenNames();
    } catch (err) {
      console.error(`${MODULE_ID} | token-name repair failed to load:`, err);
    }

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
             * Strip web escape codes out of token names, now, without a reload.
             *
             * ⚠️ THE BOOT SWEEP IS NOT THE ONLY WAY IN. Telling a GM to
             * restart his game to fix four names is asking him to pay for our
             * bug with his evening. Johnny, 2026-08-25: "I don't see why I have
             * to reload."
             *
             * @param {object} [opts]
             * @param {boolean} [opts.dryRun] list what would change, write nothing
             */
            repairTokenNames: async (opts = {}) => {
                const { repairEncodedTokenNames } = await import("./name-repair.mjs");
                const r = await repairEncodedTokenNames(opts);
                for (const f of r.fixed) {
                    console.log(`${MODULE_ID} | ${opts.dryRun ? "would repair" : "repaired"} on `
                        + `"${f.scene}": ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
                }
                for (const k of r.skipped) {
                    console.warn(`${MODULE_ID} | could not safely repair "${k.name}" on "${k.scene}".`);
                }
                const verb = opts.dryRun ? "would be repaired" : "repaired";
                ui.notifications?.info(`ACE: ${r.fixed.length} token name(s) ${verb}. `
                    + `${r.scanned} scanned.`);
                return r;
            },

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
                // Scan what the SETTINGS list, never a stale array. Reconciling
                // here means the console, the button and the startup path can
                // all only ever scan the folders actually configured.
                try { await ACETokenArtFolders.reconcileFromText(); } catch (_) {}
                // ⚠️ THE WHOLE OPTIONS OBJECT, not three fields off it. A wrapper
                // that names its arguments one by one is where `deferSave` and
                // the progress line would quietly fall off on the way through.
                const result = await rebuildTokenArtIndex({ ...opts, useCache, silent });
                if (!silent && !result.fromCache) {
                    ui.notifications?.info(`${MODULE_ID}: Rescanned — ${result.fileCount} files, ${result.baseCount} base names.`);
                }
                return result;
            },
            /** Inspect the current in-memory index (for debugging). */
            getTokenArtIndex,
            /** The hook fired each time the token-art index is (re)built; the picker listens while it waits. */
            indexReadyHook: INDEX_READY_HOOK,
            /**
             * Re-run the path-integrity / self-heal pass on demand (repairs
             * broken art paths across actors + the current scene). Returns
             * { checked, dead, repaired, unresolved }.
             */
            repairTokenArt: async (opts = {}) => auditAndRepairTokenPaths(opts),
            /**
             * The list the token art picker shows.
             *
             * ⚠️🔴 THIS WAS A SUBSTRING TEST ON THE WHOLE NAME, AND THAT IS THE
             * BUG HE AUDITED (2026-10-01): "Virric Vaesoldandros still lists only
             * files with both words. Virric 33A, Virric number 1 and Virric token
             * are in the folder and are not on that list."
             *
             * Exactly right, and my own work was in the wrong function: the
             * engine's `_findMatches` ladder, which is where the name rules went,
             * is not what the picker calls. The picker calls this, and this did
             * `baseLower.includes("virric vaesoldandros")` — one phrase, so only
             * a file carrying both words could ever be listed.
             *
             * His rule: "A file is listed when any word of his name is a word in
             * the file, after a number, a size, and token, number, portrait, img,
             * image and art are dropped. Both-words files stay listed and still
             * win the auto-pick."
             *
             * So: whole words on both sides, every name word counts on its own,
             * and the order is full phrase → every word → any word, which keeps
             * the both-words files at the top where the auto-pick reads them.
             */
            searchTokenArt: (query) => {
                const idx = getTokenArtIndex();
                /* ⚠️ THE RAW ENTRY, plus the two old aliases. The reshaped object
                   this used to return dropped `displayBase`, `baseLower` and
                   `familyFolder`, which the picker's cards and the chooser read. */
                const out = (e) => ({ ...e, base: e.displayBase, variant: e.displayVariant });
                const r = rankArtForName(idx.all, query);

                /* ⚠️ ONE LINE, WITH BOTH NUMBERS (his rule, 2026-10-01: "Print one
                   line: how many files contain the word Virric, how many the
                   picker showed."). A list that is quietly short is the whole
                   fault being fixed here, so what the folder holds and what the
                   picker shows go out together and can be compared at a glance. */
                try {
                    const per = r.words.map(w => `${w}: ${r.perWord[w]}`).join(", ");
                    console.log(`${MODULE_ID} | art for "${query}" — files holding `
                        + `${per || "no usable word"}; the picker shows ${r.listed.length} `
                        + `(${r.exact} named exactly that, ${r.every} every word, ${r.one} one word) `
                        + `of ${idx.all.length} indexed.`);
                } catch (err) { console.warn(`${MODULE_ID} | could not count the art list:`, err); }

                return r.listed.map(out);
            },

            /** The one test behind both the picker's page 1 and its full list. */
            rankArtForName,

            /**
             * Give art to every creature that has none.
             *
             * ⚠️ DRY RUN BY DEFAULT. It reports what it would do and writes
             * nothing until asked, because it can touch several hundred actors
             * in one press and there is no undo for that.
             */
            matchMissingArt: (opts) => matchMissingArt(opts),

            // ── Prone (separate folders, separate index) ──
            getProneIndex,
            /** Rebuild the prone index from the configured prone folders. */
            /**
             * Write the index the rescan held back, after every root reported.
             * His rule, 2026-10-03: nothing is saved until all three are in.
             */
            saveArtIndexCache: () => saveDeferredIndexCache(),

            rescanProneArt: async (opts = {}) => {
                try { await ACETokenArtFolders.reconcileFromText(); } catch (_) {}
                return rebuildProneIndex(opts);
            },
            /** Filename search over prone art; empty query returns them all. */
            searchProneArt: (query) => {
                const idx = getProneIndex();
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

            // ── Portraits (separate folders, separate index) ──
            getPortraitIndex,
            /** Rebuild the portrait index from the configured portrait folders. */
            rescanPortraitArt: async (opts = {}) => {
                try { await ACETokenArtFolders.reconcileFromText(); } catch (_) {}
                return rebuildPortraitIndex(opts);
            },
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
