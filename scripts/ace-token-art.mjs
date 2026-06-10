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

// ─── Settings registration ────────────────────────────────────────────────

function _registerSettings() {
    const s = (key, def) => game.settings.register(MODULE_ID, key, def);

    // ── Settings menu: opens the folder configuration dialog ──
    // Lets the GM add/remove/edit scan folders and rescan the index
    // without leaving Foundry's settings panel. Lazy-imports the dialog
    // module so we don't pull it in unless the user clicks the button.
    try {
        game.settings.registerMenu(MODULE_ID, "configureFolders", {
            name: "Token Art Folders",
            label: "Configure Folders",
            hint: "Add, remove, or edit the folders the engine scans for token art — and rescan the index without leaving the dialog.",
            icon: "fa-solid fa-folder-tree",
            restricted: true,
            type: class extends FormApplication {
                static get defaultOptions() {
                    return foundry.utils.mergeObject(super.defaultOptions, {
                        id: "ace-token-art-folder-config-launcher",
                        title: "ACE: Token Art — Folder Configuration",
                        template: null,
                        popOut: false,
                    });
                }
                async _render() {
                    // Don't actually render a form — just open the real dialog.
                    const mod = await import("./folder-config-dialog.mjs");
                    await mod.openFolderConfigDialog();
                    this.close({ submit: false });
                }
                async _updateObject() { /* no-op */ }
            },
        });
    } catch (err) {
        console.warn(`${MODULE_ID} | Folder config menu registration failed:`, err);
    }

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
        };
    }
});
