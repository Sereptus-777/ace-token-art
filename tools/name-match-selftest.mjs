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

const { _containsWordRun, _containsAllWords, _artWordsOf, _nameWordsOf,
  _firstNameWordNamingArt } = await import(
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


console.log("\nHIS SWARMS — filed backwards, which the in-order test cannot see");
// ⚠️ REAL FILENAMES OFF HIS DISK. The stat block says "Swarm of Beetles"; the
// library says "Insect_Swarm_Beetles". Same words, reversed.
const words = (n) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .filter(w => !["of","the","a","an","and"].includes(w))
  .map(w => w.length > 3 && w.endsWith("ies") ? w.slice(0,-3)+"y"
          : w.length > 3 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0,-2)
          : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0,-1) : w);
const all = (file, creature) => _containsAllWords(file, words(creature));

check("Swarm of Beetles finds Insect_Swarm_Beetles",
  all("67293_Insect_Swarm_Beetles_Medium_Beast_400x400", "Swarm of Beetles"), true);
check("Swarm of Wasps finds Insect_Swarm_Wasps",
  all("67290_Insect_Swarm_Wasps_Medium_Beast_400x400", "Swarm of Wasps"), true);
check("Swarm of Centipedes finds Insect_Swarm_Centipedes",
  all("67294_Insect_Swarm_Centipedes_Medium_Beast_400x400", "Swarm of Centipedes"), true);
check("plural and singular are the same word",
  all("67287_Insect_Swarm_Mix_A_Medium_Beast", "Swarm of Insects"), true);
check("Swarm of Rats finds its own file",
  all("28971_Swarm_of_Rats_Medium_Beast_01_400x400", "Swarm of Rats"), true);

console.log("\nAND IT STILL REFUSES THE WRONG SWARM");
// ⚠️ THE WHOLE SAFETY OF THIS STEP. Every word must be present.
check("Swarm of Beetles does NOT take Swarm of Rats",
  all("28971_Swarm_of_Rats_Medium_Beast_01_400x400", "Swarm of Beetles"), false);
check("Swarm of Venomous Snakes does NOT take Poisonous Snakes",
  all("87432_Swarm_of_Poisonous_Snakes_Tiny_Beast_01", "Swarm of Venomous Snakes"), false);
check("Swarm of Piranhas does NOT take Swarm of Quippers",
  all("28969_Swarm_of_Quippers_Medium_Beast_01", "Swarm of Piranhas"), false);
check("a creature does not match on stop words alone",
  all("Some_of_the_Other_Thing", "Swarm of Insects"), false);

/* == ONE WORD OF THE NAME IS THE WHOLE NAME OF A FILE ================== */
//
// His rule, 2026-10-01, in two parts. First: "It must not require the full sheet
// name. Split the name into words. Ignore 'the', 'a', 'of'... Match a file if any
// remaining word equals the art name."
//
// Then, the same afternoon, the order: "The name's words, stop words out, are
// tried in name order, not longest first. The first word that is the whole name
// of a file wins. 'Virric Velikov' must take Virric, not a file named Velikov.
// Dead and prone stay in their own bucket, so a dead Virric takes Virric Dead. A
// word of two letters still counts when it is the whole file name."
//
// A person reads first-name-first: the first word is the one that is theirs, and
// the surname is the family they came from. Longest-first had that backwards for
// every character with two names.
console.log("");
console.log("ONE WORD OF THE NAME");

const artWords = (t) => _artWordsOf(t).join(" ");
check("the stop words go", _nameWordsOf("Fred the Balor").join(" "), "fred balor");
check("and the name keeps its order", _nameWordsOf("Virric Velikov").join(" "), "virric velikov");
check("a two-letter word is still one of them", _nameWordsOf("Ox of the Pit").join(" "), "ox pit");
check("a size is not part of a file's name", artWords("Balor Huge Fiend 01"), "balor fiend");
check("nor is a modifier word", artWords("Summoned Spectral Wolf"), "wolf");
check("nor is the bucket: dead and prone are not a creature's name",
  artWords("Virric Dead"), "virric");
check("and prone the same", artWords("prone-virric"), "virric");

// Which word decides, given a library.
const whole = (...names) => (w) => names.some(n => {
  const ws = _artWordsOf(n);
  return ws.length === 1 && ws[0] === w;
});
check("Virric Velikov takes Virric, not Velikov",
  _firstNameWordNamingArt("Virric Velikov", whole("Virric", "Velikov")), "virric");
check("and a dead Virric takes Virric Dead",
  _firstNameWordNamingArt("Virric Velikov", whole("Virric Dead.png")), "virric");
check("Velikov only when nothing is named Virric",
  _firstNameWordNamingArt("Virric Velikov", whole("Velikov")), "velikov");
check("Fred the Balor takes Balor", _firstNameWordNamingArt("Fred the Balor", whole("Balor")), "balor");
check("a two-letter word counts when it IS the file name",
  _firstNameWordNamingArt("Ox", whole("Ox")), "ox");
check("a word inside a longer filename is not the whole name",
  _firstNameWordNamingArt("Fred the Balor", whole("Balor Huge Fiend 01")), null);
check("and a word nothing is named for decides nothing",
  _firstNameWordNamingArt("Fred the Balor", whole("Fiend")), null);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
