// Minimal ESLint config — ONE job: catch identifiers that don't exist.
//
// `node --check` validates SYNTAX only. A reference to an undeclared variable is
// perfectly valid syntax and throws only when that line actually runs. That is
// how `_targetProfileFor(targetActor, tgt)` shipped into _rollPcSave — a
// function with no `tgt` — and silently killed every player save, and how a
// second call read `r` inside its own temporal dead zone. Nothing in the build
// could have caught either. This can.
//
//   npx --yes eslint@9 "scripts/**/*.mjs"

const FOUNDRY_GLOBALS = [
  // Foundry core
  "game", "canvas", "ui", "CONFIG", "CONST", "Hooks", "foundry",
  "Roll", "ChatMessage", "Actor", "Item", "ActiveEffect", "Macro", "Folder",
  "Token", "TokenDocument", "Scene", "Combat", "Combatant", "CombatTracker",
  "User", "Users", "Dialog", "Application", "FormApplication", "DocumentSheetConfig",
  "FilePicker", "ImageHelper", "AudioHelper", "Color", "SceneNavigation",
  "renderTemplate", "loadTemplates", "TextEditor", "Handlebars",
  "fromUuid", "fromUuidSync", "duplicate", "mergeObject", "getProperty",
  "setProperty", "randomID", "jQuery", "$", "Actors", "Items", "ChatLog",
  "SettingsConfig", "KeybindingsConfig", "Tour", "ProseMirror",
  // ⚠️ `Ray` was REMOVED from this list 2026-08-06. It is NOT a global in V13 —
  // it lives at foundry.canvas.geometry.Ray. Listing it here is what let
  // `new Ray(a,b)` ship inside a try/catch in party-transfer.mjs, where it threw
  // a ReferenceError on every call, was swallowed, and silently disabled wall
  // checking so creatures landed inside walls and doorways.
  // NEVER add a name here to silence no-undef. Verify it is a real global first
  // — a false entry turns this lint from a safety net into a blindfold.
  // Third-party modules ACE talks to
  "Sequence", "Sequencer", "PIXI", "TokenMagic", "warpgate",
  // Browser / platform
  "console", "window", "document", "fetch", "URL", "URLSearchParams", "Blob",
  "FileReader", "File", "FormData", "Headers", "Request", "Response", "WebSocket",
  "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "structuredClone", "AbortController", "TextDecoder", "TextEncoder",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent",
  "HTMLElement", "HTMLImageElement", "HTMLCanvasElement", "Node", "NodeList",
  "HTMLInputElement", "HTMLVideoElement", "HTMLSelectElement", "HTMLTextAreaElement",
  "customElements", "DOMParser", "XMLSerializer",
  "Image", "Audio", "performance", "navigator", "location", "alert", "confirm",
  "atob", "btoa", "crypto", "getComputedStyle", "MutationObserver", "ResizeObserver",
];

const globals = Object.fromEntries(FOUNDRY_GLOBALS.map(g => [g, "readonly"]));

export default [
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals },
    rules: {
      // THE rule. Any error here is a guaranteed runtime ReferenceError.
      // Keep this at zero.
      "no-undef": "error",
      // ⚠️ THE RULE THAT WOULD HAVE CAUGHT HASTE. A duplicate key in an object
      // literal is silently resolved by JavaScript in favour of the LAST one:
      // Haste's live copy granted only +2 AC for months because the definition
      // holding the speed doubling and the Dex-save advantage sat above a second
      // one with the same key. Added 2026-08-19 after a hand-rolled scanner
      // produced 26 false positives and 2 real hits - a real parser does this
      // correctly and for free. Keep at error.
      "no-dupe-keys": "error",
      "no-dupe-else-if": "error",
      "no-unsafe-negation": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-constant-condition": "error",
      // WARN, not error: this also flags the perfectly legal pattern of a
      // callback referencing a const declared further down the same scope
      // (drag handlers, Hooks.off cleanup) — those run after initialisation and
      // are fine. It's kept on because it DOES catch the dangerous version: a
      // const read in its own temporal dead zone, which is what silently broke
      // the PC card update. Nine known-safe hits as of 0.7.372; if the count
      // moves, read the new one.
      "no-use-before-define": ["warn", { functions: false, classes: false, variables: true }],
    },
  },
];
