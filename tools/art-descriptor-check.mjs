// ─── A token name must never show an escape sequence ─────────────────────────
//
// ⚠️🔴 WHAT THIS IS PROVING. Foundry stores art paths URL-ENCODED. "Shadow
// Dragon 01.png" reaches the descriptor as "Shadow%20Dragon%2001.png", and the
// descriptor never decoded it. A percent sign is not one of the separators it
// splits on, so the entire filename stayed a single word; the creature's own
// words could not match it; every filter let it through; and the trailing-digit
// strip left "shadow%20dragon%".
//
// Johnny's map carried four of these on 2026-08-25, in front of his players:
//
//     "Shadow%20dragon% Shadow Dragon (Huge)"
//     "Flameskull% Flameskull"
//     "Lich% Lich (Legacy)"
//     "Arcanaloth% Arcanaloth"
//
// Every one of those filenames has a SPACE in it, which is the same fingerprint
// as the corpse-art bug of 2026-08-07 — sixteen of eighty-two death images
// unreachable, every one with a space. The death pipeline learned to decode and
// this file never did.
//
// The cases below are his ACTUAL filenames, read out of his world database, not
// tidy examples invented to pass. Tidy examples are exactly what hid this.
//
// Run:  node tools/art-descriptor-check.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { describeArt, tokenNameFromArt } = await import(
  pathToFileURL(path.join(here, "..", "scripts", "art-descriptor.mjs")).href
);

const CASES = [
  // ── The four that were live on his map ──────────────────────────────────
  {
    art: "NPCs/DRAGONS/Shadow%20Dragon%2001.png",
    creature: "Shadow Dragon (Huge)",
    want: null,
    why: "the filename is just the creature and an index — nothing to describe",
  },
  {
    art: "NPCs/UNDEAD/Flameskull%2001.png",
    creature: "Flameskull",
    want: null,
    why: "same creature name plus an index",
  },
  {
    art: "NPCs/UNDEAD_PACK/Lich%2001.png",
    creature: "Lich (Legacy)",
    want: null,
    why: "the parenthetical is not in the art, and 'Lich' is the creature",
  },
  {
    art: "NPCs/FIENDS/Arcanaloth%20033.png",
    creature: "Arcanaloth",
    want: null,
    why: "an index of 033 says nothing about which one it is",
  },

  // ── Encoded paths that DO carry a real descriptor ───────────────────────
  {
    art: "NPCs/GOBLINS/Goblin%20Archer%20Bow%2003.png",
    creature: "Goblin",
    want: "Goblin Archer",
    why: "a space-separated role survives decoding",
  },
  {
    art: "NPCs/BANDITS/Bandit%20Brute%20Club%2002.png",
    creature: "Bandit",
    want: "Bandit Brute",
    why: "role words read after the creature",
  },

  // ── The un-encoded forms must keep working exactly as before ────────────
  {
    art: "Adversaries/Goblin_Archer_Bow_03.png",
    creature: "Goblin",
    want: "Goblin Archer",
    why: "underscore library, untouched by the decode",
  },
  {
    art: "Adversaries/Skeleton_At_Ease_Spear.png",
    creature: "Skeleton",
    want: "Skeleton at Ease",
    why: "a kept phrase",
  },
  {
    art: "tokens/Goblin,green1.png",
    creature: "Goblin",
    want: "Green Goblin",
    why: "an adjective reads before the creature",
  },

  // ── Nothing to say, deliberately ────────────────────────────────────────
  {
    art: "tokens/Commoner/01.png",
    creature: "Commoner",
    want: null,
    why: "a bare index — the caller numbers instead, which is correct",
  },
  {
    art: "tokens/Golem/Base.png",
    creature: "Stone Golem",
    want: null,
    why: "'base' says nothing about which golem this is",
  },

  // ── A malformed escape must produce nothing, never mangled text ─────────
  {
    art: "NPCs/Broken%ZZ%20Thing.png",
    creature: "Thing",
    want: null,
    why: "an undecodable path is refused rather than shown",
  },
];

let ok = true;
console.log("");
console.log("TOKEN NAMES FROM ART FILENAMES");
console.log("=".repeat(78));

for (const c of CASES) {
  let got;
  try {
    got = tokenNameFromArt(c.art, c.creature);
  } catch (err) {
    got = `THREW: ${err?.message ?? err}`;
  }
  const clean = typeof got !== "string" || !got.includes("%");
  const pass = got === c.want && clean;
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.art}`);
  console.log(`        ${got === null ? "(numbered instead)" : JSON.stringify(got)}`);
  console.log(`        ${c.why}`);
  if (!pass) {
    console.log(`        EXPECTED ${c.want === null ? "(numbered instead)" : JSON.stringify(c.want)}`);
    if (!clean) console.log("        AND IT LEAKED AN ESCAPE SEQUENCE INTO A NAME");
  }
}

// A blunt sweep: no input may ever produce a name containing a percent sign.
const leaked = CASES
  .map(c => { try { return tokenNameFromArt(c.art, c.creature); } catch (_) { return null; } })
  .filter(n => typeof n === "string" && n.includes("%"));
console.log("");
console.log("=".repeat(78));
if (leaked.length) { ok = false; console.log(`${leaked.length} name(s) still carry an escape sequence.`); }
console.log(ok
  ? "ALL PASS — the path is decoded before it is read, and no name shows an escape."
  : "FAILURES ABOVE — a GM would see this on their own map.");
process.exit(ok ? 0 : 1);
