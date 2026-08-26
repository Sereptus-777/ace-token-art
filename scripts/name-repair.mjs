// ─── ACE: Token Art — take the escape sequences back off his map ─────────────
//
// ⚠️🔴 WHY THIS EXISTS. Until 2026-08-25 the descriptor read art filenames
// without URL-decoding them, so every file with a SPACE in its name produced a
// token called something like "Shadow%20dragon% Shadow Dragon (Huge)". The
// descriptor is fixed at source; this puts right the names it already wrote.
//
// Johnny's world had four, sitting on the map in front of his players:
//     "Shadow%20dragon% Shadow Dragon (Huge)"
//     "Flameskull% Flameskull"
//     "Lich% Lich (Legacy)"
//     "Arcanaloth% Arcanaloth"
//
// ⚠️ FIXING THE SOURCE IS NOT FIXING THE DAMAGE. A rename is persisted in the
// scene, so a corrected descriptor changes nothing about the tokens already
// standing there. The condition-ghost sweeper of 2026-08-12 taught this the
// hard way: thirteen ghosts survived every reload because the fix only stopped
// NEW ones being made.
//
// ⚠️ AND IT TELLS THE GM WHAT IT DID. A repair that runs silently is
// indistinguishable from a repair that never ran.
//
// ⚠️ IT ONLY EVER REMOVES AN ESCAPE SEQUENCE. It does not rename, renumber or
// re-describe anything. A word containing a percent-escape is dropped and the
// rest of the name is left exactly as it stands. A name a human typed that
// happens to contain a percent sign but no escape is never touched.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-token-art.mjs";

/** A word that is an encoding artifact rather than something a person wrote. */
const ARTIFACT = /%[0-9A-Fa-f]{2}|%$/;

/**
 * Strip encoding artifacts out of one name.
 *
 * @param {string} name
 * @returns {string|null} the cleaned name, or null when there is nothing to fix
 */
export function cleanName(name) {
  const raw = String(name ?? "");
  if (!raw.includes("%")) return null;

  const kept = raw.split(/\s+/).filter(w => w && !ARTIFACT.test(w));
  const cleaned = kept.join(" ").trim();

  // ⚠️ NEVER LEAVE A TOKEN WITH NO NAME. If stripping the artifact would empty
  // the name entirely, the artifact was the whole name and there is nothing
  // safe to put back — leave it alone and let the report name it, so a human
  // decides rather than a sweeper guessing.
  if (!cleaned) return null;
  return cleaned === raw ? null : cleaned;
}

/**
 * Find and repair every token name carrying an encoding artifact.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] report only, write nothing
 * @returns {Promise<{scanned:number, fixed:Array, skipped:Array}>}
 */
export async function repairEncodedTokenNames({ dryRun = false } = {}) {
  const result = { scanned: 0, fixed: [], skipped: [] };
  if (!game.user?.isGM) return result;

  for (const scene of game.scenes ?? []) {
    const updates = [];
    for (const t of scene.tokens ?? []) {
      result.scanned++;
      const name = t.name ?? "";
      if (!name.includes("%")) continue;

      const cleaned = cleanName(name);
      if (!cleaned) {
        // Held a percent sign but nothing safe to do about it.
        if (ARTIFACT.test(name)) result.skipped.push({ scene: scene.name, name });
        continue;
      }
      result.fixed.push({ scene: scene.name, from: name, to: cleaned });
      updates.push({ _id: t.id, name: cleaned });
    }

    if (updates.length && !dryRun) {
      try {
        await scene.updateEmbeddedDocuments("Token", updates);
      } catch (err) {
        // ⚠️ A FAILED REPAIR MUST NOT REPORT AS A DONE ONE. Move those rows
        // out of "fixed" so the count the GM reads is the truth.
        console.error(`${MODULE_ID} | could not repair names on "${scene.name}":`, err);
        for (const u of updates) {
          const i = result.fixed.findIndex(f => f.to === u.name && f.scene === scene.name);
          if (i >= 0) result.skipped.push(result.fixed.splice(i, 1)[0]);
        }
      }
    }
  }
  return result;
}

/** Run the repair at boot and say what happened. */
export async function sweepEncodedTokenNames() {
  try {
    const r = await repairEncodedTokenNames();
    if (!r.fixed.length && !r.skipped.length) return;

    for (const f of r.fixed) {
      console.log(`${MODULE_ID} | name repaired on "${f.scene}": `
        + `${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
    }
    for (const s of r.skipped) {
      console.warn(`${MODULE_ID} | "${s.name}" on "${s.scene}" holds an escape `
        + `sequence and nothing could be safely removed. Rename it by hand.`);
    }

    if (r.fixed.length) {
      ui.notifications?.info(
        `ACE repaired ${r.fixed.length} token name${r.fixed.length === 1 ? "" : "s"} `
        + `that were showing web escape codes. The console lists them.`);
    }
    if (r.skipped.length) {
      ui.notifications?.warn(
        `ACE found ${r.skipped.length} token name${r.skipped.length === 1 ? "" : "s"} `
        + `it could not safely repair. The console names them.`);
    }
  } catch (err) {
    // ⚠️ ABSENT AND BROKEN MUST NOT PRINT THE SAME MESSAGE.
    console.error(`${MODULE_ID} | the token-name repair could not run at all:`, err);
  }
}
