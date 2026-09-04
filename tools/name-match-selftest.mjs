// ─── Does the matcher find the creature inside a filename? ───────────────────
//
// ⚠️ EVERY CASE HERE IS A REAL FILE OFF JOHNNY'S DISK, and every one of them
// was reported as "nothing in your folders" on 2026-09-03 while sitting in the
// folder he had just approved. The matcher only ever looked for files whose
// name the creature's name STARTS with; his library names things
// `Gynosphinx_Large_Scale200_Monstrosity_A_01.png`.
//
// ⚠️ THE CROCODILE IS THE POINT OF THE TEST. "Roc" is inside "Crocodile", and a
// plain substring test would have handed him a crocodile while looking like a
// correct match. Whole words in sequence is the whole difference.
//
// Run:  node tools/name-match-selftest.mjs
globalThis.game = { settings: { get: () => false, register: () => {} }, user: { isGM: true },
  modules: { get: () => null }, i18n: { localize: (k) => k } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = { Actor: {}, Token: {} };
globalThis.foundry = { utils: { escapeHTML: (s) => String(s) },
  applications: { apps: {} } };
globalThis.canvas = { grid: { size: 100 } };

const { _containsWordRun } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-token-art/scripts/token-art-engine.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(60) + "got " + got + ", want " + want);
};
const tok = (name) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const finds = (file, creature) => _containsWordRun(file, tok(creature));

console.log("\nHIS OWN FILES, THE ONES THAT WERE MISSED");
check("Gynosphinx_Large_Scale200_Monstrosity_A_01.png",
  finds("Gynosphinx_Large_Scale200_Monstrosity_A_01", "Gynosphinx"), true);
check("Will-o-Wisp_Tiny_Undead_01.png",
  finds("Will-o-Wisp_Tiny_Undead_01", "Will-o'-Wisp"), true);
check("114606_Pteranodon_Large_Scale200_Beast_01.png  (leading number)",
  finds("114606_Pteranodon_Large_Scale200_Beast_01", "Pteranodon"), true);
check("2024-mm2024-piranha.jpeg  (two prefixes)",
  finds("2024-mm2024-piranha", "Piranha"), true);
check("a two-word creature in the middle",
  finds("2024-mm2024-swarm-of-insects", "Swarm of Insects"), true);
check("Minotaur of Baphomet",
  finds("2024-mm2024-minotaur-of-baphomet", "Minotaur of Baphomet"), true);

console.log("\nTHE CROCODILE TRAP — a substring test fails every one of these");
// ⚠️ These are the false matches the naive version would have made, and they
// would have looked right in a list of results.
check("Roc must NOT match Crocodile_Large_Beast_01",
  finds("Crocodile_Large_Beast_01", "Roc"), false);
check("Roc must NOT match Rock Gnome",
  finds("Rock_Gnome_Medium_Humanoid_01", "Roc"), false);
check("Ape must NOT match Grape Ooze",
  finds("Grape_Ooze_01", "Ape"), false);
check("Rat must NOT match Pirate Captain",
  finds("Pirate_Captain_01", "Rat"), false);
check("Roc DOES match its own file",
  finds("Roc_Gargantuan_Monstrosity_01", "Roc"), true);

console.log("\nORDER MATTERS, AND SO DOES BEING CONTIGUOUS");
check("the words must be in order",
  finds("Insects_Swarm_Of_Beetles", "Swarm of Insects"), false);
check("and next to each other",
  finds("Swarm_Large_Of_Angry_Insects", "Swarm of Insects"), false);
check("but separators do not matter",
  finds("swarm.of.insects", "Swarm Of Insects"), true);
check("and neither does case",
  finds("SWARM_OF_INSECTS", "swarm of insects"), true);

console.log("\nNOTHING SILLY GETS THROUGH");
check("an empty needle matches nothing", _containsWordRun("anything", []), false);
check("an empty haystack matches nothing", finds("", "Goblin"), false);
check("a null haystack matches nothing", _containsWordRun(null, ["goblin"]), false);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
