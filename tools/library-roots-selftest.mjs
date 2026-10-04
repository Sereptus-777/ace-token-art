// ─── THREE LIBRARIES, THREE ROOTS, ONE RESCAN ────────────────────────────────
//
// His rules, 2026-10-03:
//
//   "Point the token tab at D:/FoundryVTT/Data/1_tokens. Point portraits at
//    D:/FoundryVTT/Data/1_portraits. Point a death or a prone swap at
//    D:/FoundryVTT/Data/1_dead-prone. Ignore _PSD Sources and any file that is
//    not an image... modules/ace-qol/Assets/Dead stays in the module and is
//    checked only after 1_dead-prone."
//
//   "Rescan reads all three roots and does not save until every root has
//    reported. A second click while it is running does nothing. Show a progress
//    line while it walks. When it finishes, one toast, not red, and it goes away
//    on its own. The token tab never lists a portrait or a dead-prone file. A
//    portrait search never lists a token."
//
// Run:  node tools/library-roots-selftest.mjs
import { readFileSync } from "node:fs";

const M = "D:/FoundryVTT/Data/modules/ace-token-art";
const main = readFileSync(`${M}/scripts/ace-token-art.mjs`, "utf8");
const engine = readFileSync(`${M}/scripts/token-art-engine.mjs`, "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};

console.log("\nEACH TAB POINTS AT ITS OWN LIBRARY");
{
  check("the token tab reads 1_tokens", /default: \["1_tokens"\]/.test(main));
  check("portraits read 1_portraits", /default: \["1_portraits"\]/.test(main));
  /* ⚠️ HIS ORDER: his own library first, the module's folder behind it. */
  check("a death or a prone swap reads 1_dead-prone first",
    /default: \["1_dead-prone", "modules\/ace-qol\/Assets\/Dead"/.test(main),
    "Assets/Dead is the fallback, not the first answer");
  /* ⚠️🔴 AND Assets/Prone IS STILL THERE, which he did not name. It holds the
     only prone pictures of eight named characters, none of them in the manifest
     or in 1_dead-prone; dropping it on his silence would have taken their art
     away without a word. */
  check("and Assets/Prone is still on the list, so eight named characters keep their art",
    /"modules\/ace-qol\/Assets\/Prone"\]/.test(main), "last, behind both");
  check("the text field says the same as the stored list",
    /default: "1_dead-prone\\nmodules\/ace-qol\/Assets\/Dead\\nmodules\/ace-qol\/Assets\/Prone"/.test(main));
}

console.log("\nA WALK NEVER CROSSES INTO ANOTHER LIBRARY");
{
  check("there is one test for what a walk refuses to open",
    /function _skipThisFolder\(dir, skipDirs\)/.test(engine));
  /* ⚠️ "Ignore _PSD Sources and any file that is not an image." */
  check("_PSD Sources is never opened",
    /_psd sources\$/.test(engine), "by name, before the walk pays for it");
  check("and only images are kept",
    /if \(ART_EXT_RE\.test\(file\)\) found\.push\(file\)/.test(engine), "every other file is passed over");
  check("each walk is told the other two roots",
    /function _otherLibraryRoots\(mine\)/.test(engine)
    && /skipDirs: _otherLibraryRoots\("token"\)/.test(engine)
    && /skipDirs: _otherLibraryRoots\("portrait"\)/.test(engine)
    && /skipDirs: _otherLibraryRoots\("prone"\)/.test(engine),
    "all three");
  /* ⚠️ A ROOT THIS LIBRARY ALSO OWNS IS NOT SOMEBODY ELSE'S: two tabs on one
     folder is something he may do on purpose, and refusing to walk his own root
     would hand him an empty tab with no reason given. */
  check("but never its own root, even when two tabs share one folder",
    /filter\(x => !mineSet\.has/.test(engine));
}

console.log("\nONE RESCAN, ALL THREE ROOTS, ONE SAVE");
{
  check("there is one door for the rescan", /export async function rescanAllArt\(\)/.test(main));
  /* ⚠️ "A second click while it is running does nothing." */
  check("a second click while it runs does nothing, and says so quietly",
    /if \(_rescanInFlight\) \{/.test(main) && /already walking the folders/.test(main));
  /* ⚠️ "does not save until every root has reported" */
  check("the token walk holds its save",
    /deferSave: true/.test(main) && /if \(deferSave\) _pendingCacheFolders = folders;/.test(engine));
  check("and the save happens once, after all three",
    /const saved = await api\?\.saveArtIndexCache\?\.\(\);/.test(main)
    && /export async function saveDeferredIndexCache\(\)/.test(engine));
  /* ⚠️ "Show a progress line while it walks." */
  check("a progress line is opened and updated as it walks",
    /\{ progress: true \}/.test(main) && /onProgress\?\.\(\{ dirs: dirCount/.test(engine));
  /* ⚠️ "one toast, not red, and it goes away on its own" */
  /* ⚠️ READ THE STATEMENT, NOT THE PARAGRAPH. The comment above this line says
     the word "permanent" to explain why it is not there, and a pin with a wide
     window fails on the explanation. Three times in two days now. */
  const toastLine = main.split(/\r?\n/).find(l => /ui\.notifications\?\.info\(summary\)/.test(l)) ?? "";
  check("it finishes with one toast, and it is not red",
    !!toastLine && !/permanent/.test(toastLine)
    && (main.match(/ui\.notifications\?\.info\(summary/g) ?? []).length === 1,
    "one info, no warn, no error, no permanent");
  check("and an empty root is a clause on that line, not a banner of its own",
    /Nothing found for: \$\{empties\.join\(", "\)\}/.test(main));
  check("the whole options object reaches the rebuild, so deferSave cannot fall off",
    /rebuildTokenArtIndex\(\{ \.\.\.opts, useCache, silent \}\)/.test(main));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
