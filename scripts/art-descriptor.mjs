// ─── ACE: Token Art — Descriptive token names from art filenames ────────────
//
// Johnny, 2026-08-08: "I'm really tired of seeing golem one, golem two. I don't
// like the numbering thing. It's not realistic… but I definitely need to tell
// the difference between which goblin is what, and so did the players."
//
// The number only exists because nothing else tells them apart. But his art
// ALREADY says what each one is — 140 goblin tokens across 14 variants, and the
// Adversaries packs name every one by role and weapon:
//
//     Goblin_Archer_Bow_03            ->  Goblin Archer
//     Bandit_Brute_Club_02            ->  Bandit Brute
//     Drow_Matron_Mother_Rod          ->  Drow Matron Mother
//     Skeleton_At_Ease_Spear          ->  Skeleton at Ease
//     Goblin,green1                   ->  Green Goblin
//
// "I shoot the bomber first" is a sentence a person says at a table.
// "I shoot Goblin 4" is inventory management.
//
// ⚠️ THIS ONLY EVER RENAMES A TOKEN. Never the actor, never a compendium.
//
// ⚠️ AND IT FAILS TO A NUMBER, DELIBERATELY. A large part of his library
// carries all its meaning in the FOLDER and numbers the files — 01.png, A, B,
// Base, Blue. There is nothing to extract there and inventing something would
// be worse than a number. Nine identical commoners get numbered, because
// nothing distinguishes them on the map either.
//
// LEAF MODULE — imports nothing, so every rule below is testable outside Foundry.
// ──────────────────────────────────────────────────────────────────────────────

/** Words that describe what the creature IS DOING or what ROLE it fills.
 *  These read naturally AFTER the creature name: "Goblin Archer". */
const ROLE_WORDS = new Set([
  "archer", "bomber", "brute", "bully", "brawler", "captain", "caster", "chief",
  "chieftain", "cleric", "commander", "consort", "druid", "elite", "fighter",
  "guard", "gunner", "healer", "knight", "leader", "mage", "matron", "minion",
  "mother", "necromancer", "noble", "peasant", "priest", "ranger", "rogue",
  "scout", "sentry", "shaman", "skirmisher", "sorcerer", "spellcaster",
  "thug", "veteran", "warlock", "warlord", "warrior", "witch", "wizard",
  "barbarian", "bard", "monk", "paladin", "assassin", "berserker", "champion",
  "favored", "favoured", "boss", "king", "queen", "lord", "lady", "prince",
]);

/** Words describing APPEARANCE or STATE. These read naturally BEFORE the
 *  creature name: "Broken Skeleton", "Green Goblin", "Armoured Bandit". */
const ADJECTIVE_WORDS = new Set([
  "armored", "armoured", "broken", "burning", "charred", "cloaked", "crazed",
  "dark", "dead", "feral", "frozen", "giant", "grim", "hooded", "hulking",
  "injured", "large", "lean", "mounted", "old", "ragged", "robed", "rotting",
  "scarred", "shielded", "small", "tattered", "wounded", "young",
  "green", "tan", "red", "blue", "black", "white", "grey", "gray", "brown",
  "pale", "golden", "silver", "rusty", "bloody",
]);

/** Multi-word phrases worth keeping intact, checked before word-by-word work.
 *  Key is the underscore/space form as it appears in a filename. */
const PHRASES = [
  { match: ["at", "ease"],     text: "at Ease",     position: "after" },
  { match: ["dual", "wield"],  text: "Dual-Wielding", position: "before" },
  { match: ["rune", "carved"], text: "Rune-Carved", position: "before" },
  { match: ["matron", "mother"], text: "Matron Mother", position: "after" },
  { match: ["guard", "captain"], text: "Guard Captain", position: "after" },
  { match: ["elite", "warrior"], text: "Elite Warrior", position: "after" },
];

/** Weapons. DROPPED when a role is already present — Johnny asked for
 *  "Bandit Brute", not "Bandit Brute with Club". Kept when they are the ONLY
 *  thing distinguishing the token, because then they are the whole point. */
const WEAPON_WORDS = new Set([
  "axe", "axes", "bow", "club", "crossbow", "dagger", "dagger", "flail",
  "glaive", "greataxe", "greatsword", "halberd", "hammer", "javelin", "knife",
  "lance", "mace", "maul", "pike", "pitchfork", "quarterstaff", "rapier",
  "rod", "scimitar", "shield", "shortsword", "shovel", "sling", "spear",
  "staff", "sword", "swords", "torch", "trident", "unarmed", "warhammer", "whip",
]);

/** A weapon standing alone becomes a role noun so it reads like a person. */
const WEAPON_AS_ROLE = {
  bow: "Archer", crossbow: "Crossbowman", spear: "Spearman",
  sword: "Swordsman", swords: "Swordsman", axe: "Axeman", axes: "Axeman",
  club: "Clubman", staff: "Staffbearer", shield: "Shieldbearer",
};

/** Pure noise. Pack indices, render flags, export junk, dates. */
const NOISE_WORDS = new Set([
  "base", "token", "tokens", "img", "image", "png", "webp", "jpg", "jpeg",
  "copy", "utc", "magic", "scale", "medium", "small", "large", "huge", "tiny",
  "avatar", "journal", "portrait", "subject", "final", "new", "old", "v", "ver",
  "version", "alt", "variant", "colour", "color",
]);

/**
 * Turn an art file path into a descriptive suffix/prefix for a token name.
 *
 * @param {string} artPath       full path or bare filename of the token art
 * @param {string} creatureName  the creature's own name, so its own words are
 *                               not repeated back ("Goblin_Archer" -> "Archer")
 * @returns {{before: string, after: string, usable: boolean}}
 *   `usable:false` means nothing meaningful was found — the caller must fall
 *   back to numbering rather than invent something.
 */
export function describeArt(artPath, creatureName = "") {
  const empty = { before: "", after: "", usable: false };
  if (!artPath || typeof artPath !== "string") return empty;

  // Filename only, extension gone.
  let base = artPath.split(/[\\/]/).pop() ?? "";
  base = base.replace(/\.[a-z0-9]{2,5}$/i, "");
  if (!base) return empty;

  // Strip a leading catalogue id: "107376_Barbarian_Greataxe", "210182-Goblin",
  // "01-013.wood-elf-barbarian".
  base = base.replace(/^[\d]+[-_.]?[\d]*[-_.]/, "");

  // Strip a trailing parenthetical timestamp: "(2021_07_15 14_47_44 UTC)".
  base = base.replace(/\([^)]*\)\s*$/, "");

  // Split on every separator this library actually uses: _ - , . and space.
  let words = base.split(/[\s_\-,.]+/).map(w => w.trim()).filter(Boolean);

  // The creature's own words are not descriptive of WHICH one it is.
  const ownWords = new Set(
    String(creatureName).toLowerCase().split(/[\s_\-,.()]+/).filter(Boolean)
  );

  words = words.filter(w => {
    const lw = w.toLowerCase().replace(/\d+$/, "");   // "green1" -> "green"
    if (!lw) return false;
    if (lw.length < 2) return false;                  // bare A / B variant marks
    if (/^\d+$/.test(w)) return false;                // pure indices
    if (/^\d+x\d+$/i.test(w)) return false;           // 400x400
    if (NOISE_WORDS.has(lw)) return false;
    if (ownWords.has(lw)) return false;
    return true;
  }).map(w => w.toLowerCase().replace(/\d+$/, ""));

  if (!words.length) return empty;

  const before = [];
  const after  = [];
  const used   = new Set();

  // Phrases first — "at ease" must not be torn into two useless words.
  for (const p of PHRASES) {
    for (let i = 0; i <= words.length - p.match.length; i++) {
      if (used.has(i)) continue;
      const slice = words.slice(i, i + p.match.length);
      if (slice.every((w, k) => w === p.match[k])) {
        (p.position === "before" ? before : after).push(p.text);
        for (let k = 0; k < p.match.length; k++) used.add(i + k);
        break;
      }
    }
  }

  const rest = words.filter((_, i) => !used.has(i));
  // A captured phrase IS the descriptor — "Dual-Wielding Bandit" says it all,
  // and appending "Axeman" on top just makes it long. Any phrase counts,
  // whichever side of the name it landed on.
  const hasRole = rest.some(w => ROLE_WORDS.has(w)) || after.length > 0 || before.length > 0;

  for (const w of rest) {
    if (ADJECTIVE_WORDS.has(w)) { before.push(_title(w)); continue; }
    if (ROLE_WORDS.has(w))      { after.push(_title(w));  continue; }
    if (WEAPON_WORDS.has(w)) {
      // A role is already saying what it is — the weapon is redundant detail.
      // (Johnny, 2026-08-08: "Bandit brute is fine.")
      if (hasRole) continue;
      after.push(WEAPON_AS_ROLE[w] ?? _title(w));
      continue;
    }
    // Unknown word — could be a species ("goliath", "drow") or a proper noun.
    // Keep it in front, where species reads correctly: "Wood Elf Barbarian".
    before.push(_title(w));
  }

  const beforeText = _dedupe(before).join(" ");
  const afterText  = _dedupe(after).join(" ");
  return {
    before: beforeText,
    after:  afterText,
    usable: !!(beforeText || afterText),
  };
}

/**
 * The full token name for a creature wearing this art.
 *
 * @returns {string|null} null when the art says nothing — caller numbers instead.
 */
export function tokenNameFromArt(artPath, creatureName) {
  const d = describeArt(artPath, creatureName);
  if (!d.usable) return null;
  const name = [d.before, String(creatureName ?? "").trim(), d.after]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return name || null;
}

function _title(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Case-insensitive de-dupe, first occurrence wins, order preserved. */
function _dedupe(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
