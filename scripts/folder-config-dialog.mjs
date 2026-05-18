// ─── ACE: Token Art — Folder Configuration Dialog ─────────────────────────
// Lets the GM add/remove/edit folders that the engine scans for token art,
// and trigger a rescan without leaving the dialog. Replaces what used to be
// "edit the array setting via console."
//
// Each row is an editable text input + a FilePicker browse button + a
// remove button. Add new rows with the "+ Add Folder" button. Rescan
// updates the in-memory index immediately and shows the result inline.

import { MODULE_ID } from "./ace-token-art.mjs";

const TAG = "ACE: Token Art | Config";

/**
 * Open the folder configuration dialog.
 * Reads current folder list from `tokenArtFolders` setting and lets the user
 * edit it. Save persists the new list. Rescan rebuilds the index in-place
 * and surfaces file/creature counts in the dialog footer.
 */
export async function openFolderConfigDialog() {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;

    const escape = (s) => String(s ?? "").replace(/&/g, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const renderRow = (folder, i) => `
      <div class="atac-row" data-i="${i}" style="display:flex; gap:6px; margin-bottom:6px; align-items:center;">
        <input type="text"
               class="atac-folder-input"
               value="${escape(folder)}"
               data-i="${i}"
               placeholder="e.g. NPCs or assets/tokens/MM"
               style="flex:1; font-family: monospace; font-size:12px; padding:4px 6px; background:#1a1a1a; color:#dcdcdc; border:1px solid #555; border-radius:3px;" />
        <button type="button"
                class="atac-browse-btn"
                data-i="${i}"
                title="Browse for a folder"
                style="padding:4px 8px; background:#2a2a2a; border:1px solid #555; border-radius:3px; cursor:pointer;">
          <i class="fas fa-folder-open"></i>
        </button>
        <button type="button"
                class="atac-remove-btn"
                data-i="${i}"
                title="Remove this folder"
                style="padding:4px 8px; background:#3a1a1a; color:#ffc0c0; border:1px solid #6a3a3a; border-radius:3px; cursor:pointer;">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `;

    const folders = (() => {
        try { return (game.settings.get(MODULE_ID, "tokenArtFolders") ?? []).slice(); }
        catch (_) { return []; }
    })();

    const content = `
      <div style="padding: 4px 8px;">
        <p style="font-size:12px; line-height:1.5; color:#bbb;">
          Token Art scans these folders <strong>recursively</strong> for image
          files. Add the folders where your token art lives — subfolders are
          included automatically.
        </p>

        <div style="font-size:12px; font-weight:600; color:#d4af37; margin: 10px 0 6px 0; letter-spacing:0.5px;">
          FOLDERS TO SCAN:
        </div>

        <div id="atac-folder-list">
          ${folders.length
            ? folders.map((f, i) => renderRow(f, i)).join("")
            : `<div style="color:#888; font-style:italic; font-size:12px; padding:6px;">No folders configured. Click "Add Folder" to get started.</div>`
          }
        </div>

        <button type="button" id="atac-add-btn"
                style="width:100%; margin-top:6px; padding:6px; background:#1a2a1a; color:#a0e0a0; border:1px solid #3a5a3a; border-radius:3px; cursor:pointer; font-size:12px;">
          <i class="fas fa-plus"></i> Add Folder
        </button>

        <hr style="border:none; border-top:1px solid #333; margin: 14px 0 10px 0;">

        <div id="atac-status" style="font-size:11px; color:#888; min-height:18px; line-height:1.5;">
          Click <strong>Rescan Now</strong> after editing to rebuild the index.
        </div>
      </div>
    `;

    // Browse handler used by both initial rows and dynamically-added ones
    const bindBrowse = (btn, input) => {
        btn.addEventListener("click", () => {
            try {
                const fp = new FP({
                    type: "folder",
                    current: input?.value || "",
                    callback: (path) => { if (input) input.value = path; },
                });
                fp.browse();
            } catch (err) {
                // FilePicker.type "folder" not supported in this version —
                // fall back to plain "data" type; user picks a file inside
                // the folder, we extract the parent dir.
                console.warn(`${TAG} | "folder" mode failed, falling back to file pick:`, err);
                try {
                    const fp = new FP({
                        type: "data",
                        current: input?.value || "",
                        callback: (path) => {
                            if (!input) return;
                            const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                            input.value = dir;
                        },
                    });
                    fp.browse();
                } catch (err2) {
                    ui.notifications?.warn("Folder picker not available — type the path manually.");
                }
            }
        });
    };

    const bindRemove = (btn, row) => {
        btn.addEventListener("click", () => row.remove());
    };

    // ── Render via DialogV2 if available, otherwise fall back to V1 Dialog ──
    const DialogV2 = foundry.applications?.api?.DialogV2;

    const collectFolders = (rootEl) => {
        const inputs = rootEl.querySelectorAll(".atac-folder-input");
        return [...inputs].map(i => i.value.trim()).filter(Boolean);
    };

    const wireInteractivity = (rootEl) => {
        // Existing rows
        rootEl.querySelectorAll(".atac-row").forEach(row => {
            const input  = row.querySelector(".atac-folder-input");
            const browse = row.querySelector(".atac-browse-btn");
            const remove = row.querySelector(".atac-remove-btn");
            if (browse && input) bindBrowse(browse, input);
            if (remove)          bindRemove(remove, row);
        });

        // Add-folder button
        const addBtn = rootEl.querySelector("#atac-add-btn");
        if (addBtn) {
            addBtn.addEventListener("click", () => {
                const list = rootEl.querySelector("#atac-folder-list");
                // Clear "no folders configured" placeholder if present
                const placeholder = list.querySelector("div[style*='italic']");
                if (placeholder) placeholder.remove();
                const i = list.querySelectorAll(".atac-row").length;
                const wrapper = document.createElement("div");
                wrapper.innerHTML = renderRow("", i);
                const newRow = wrapper.firstElementChild;
                list.appendChild(newRow);
                const newInput  = newRow.querySelector(".atac-folder-input");
                const newBrowse = newRow.querySelector(".atac-browse-btn");
                const newRemove = newRow.querySelector(".atac-remove-btn");
                if (newBrowse && newInput) bindBrowse(newBrowse, newInput);
                if (newRemove)             bindRemove(newRemove, newRow);
                newInput?.focus();
            });
        }
    };

    const doRescan = async (rootEl) => {
        const status = rootEl.querySelector("#atac-status");
        if (status) status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Scanning… (this rebuilds the cache for next reload)`;
        try {
            // Save current edits first, THEN rescan — rescan reads the
            // setting fresh each time. Pass useCache:false so this button
            // ALWAYS does a fresh disk scan (the whole point of the button).
            const folders = collectFolders(rootEl);
            await game.settings.set(MODULE_ID, "tokenArtFolders", folders);
            const result = await game.modules.get(MODULE_ID).api.rescanTokenArt({ useCache: false });
            if (status) {
                const fileCount = result?.fileCount ?? 0;
                const baseCount = result?.baseCount ?? 0;
                status.innerHTML = `<span style="color:#a0e0a0;"><i class="fas fa-check"></i> Scan complete: <strong>${fileCount.toLocaleString()}</strong> files / <strong>${baseCount.toLocaleString()}</strong> creature bases indexed. Cache saved.</span>`;
            }
            ui.notifications?.info?.(`ACE: Token Art — indexed ${result?.fileCount ?? 0} files. Cache saved for next reload.`);
        } catch (err) {
            console.error(`${TAG} | Rescan failed:`, err);
            if (status) status.innerHTML = `<span style="color:#e08080;"><i class="fas fa-exclamation-triangle"></i> Rescan failed: ${escape(err.message ?? String(err))}</span>`;
        }
    };

    const doSave = async (rootEl) => {
        const folders = collectFolders(rootEl);
        await game.settings.set(MODULE_ID, "tokenArtFolders", folders);
        ui.notifications?.info?.(`ACE: Token Art — saved ${folders.length} folder${folders.length === 1 ? "" : "s"}. Click Rescan to rebuild the index.`);
    };

    // ── Use DialogV2 when available (Foundry V13 native) ───────────────────
    if (DialogV2) {
        const root = await DialogV2.prompt({
            window: { title: "ACE: Token Art — Folder Configuration", icon: "fa-folder-tree" },
            position: { width: 620 },
            content,
            ok: { label: "Save & Close", icon: "fa-save", callback: async (_event, _button, dialog) => {
                await doSave(dialog.element);
            }},
            buttons: [
                { action: "rescan", label: "Rescan Now", icon: "fa-sync", callback: async (event, _button, dialog) => {
                    event.preventDefault?.();
                    await doRescan(dialog.element);
                    // Return false to prevent dialog from closing on rescan
                    return false;
                }},
            ],
            render: (_event, dialog) => wireInteractivity(dialog.element),
            rejectClose: false,
        }).catch(() => null);
        return root;
    }

    // ── V1 fallback ────────────────────────────────────────────────────────
    return new Promise(resolve => {
        const d = new Dialog({
            title: "ACE: Token Art — Folder Configuration",
            content,
            buttons: {
                rescan: {
                    icon: '<i class="fas fa-sync"></i>',
                    label: "Rescan Now",
                    callback: async (html) => {
                        const el = html instanceof HTMLElement ? html : html[0];
                        await doRescan(el);
                        // Re-open after rescan so user can keep editing
                        setTimeout(() => openFolderConfigDialog(), 100);
                    },
                },
                save: {
                    icon: '<i class="fas fa-save"></i>',
                    label: "Save & Close",
                    callback: async (html) => {
                        const el = html instanceof HTMLElement ? html : html[0];
                        await doSave(el);
                    },
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel",
                },
            },
            default: "save",
            render: (html) => {
                const el = html instanceof HTMLElement ? html : html[0];
                wireInteractivity(el);
            },
            close: () => resolve(),
        }, { width: 620 });
        d.render(true);
    });
}
