# ACE: Token Art

A standalone Foundry VTT module that swaps placed-token images to art read from your own configured folders. When a token is created on the canvas, a floating thumbnail chooser pops up showing every matching file the engine found in your folders — pick the variant you want with mouse, keyboard, or just press Enter to use the highlighted one.

## How it works

On world load the engine recursively scans your configured folders (default: `Data/NPCs/` and `Data/assets/srd5e/img/bestiary/tokens/MM/`, plus any subfolders) for image files. It indexes everything by creature name with three matching strategies:

1. **Folder-as-creature** — a folder named "Goblin" containing `Goblin Boss.webp` + `Goblin Archer.webp` is treated as creature "Goblin" with variants "Boss" and "Archer."
2. **Filename-with-separator** — a file called `Goblin - Archer.webp` is read as base "Goblin" + variant "Archer."
3. **CamelCase split** — a file called `AirMyrmidon.webp` is parsed as "Air Myrmidon."

When a token spawns, the engine:
- Strips common modifier prefixes (Conjured, Summoned, Adult, Young, Ancient...) and retries the lookup.
- Skips files that are already inside your configured folders (it considers those "already good").
- Pops the chooser if any matches were found.
- Toasts a warning if nothing matched, including the filename to drop in to fix it.

## Filename convention

```
NPCs/
  Goblin/
    Goblin.webp              ← base art for "Goblin"
    Goblin - Archer.webp     ← variant "Archer" — picked from chooser
    Goblin - Boss.webp       ← variant "Boss"
  Air Elemental/
    Air_Large_Elemental_01.png  ← variant "Large 01"
    Air_Large_Elemental_02.png  ← variant "Large 02"
    ...
```

Category bins (folders where most filenames *don't* share words with the folder name — e.g. an "MM Monsters" folder holding 100 unrelated creatures) are detected automatically; each file inside becomes its own creature instead of all being lumped together.

## Settings

- **Enable Auto Token Art** — master switch. Off = feature inactive.
- **Auto-Rename Token on Variant Pick** — when you pick "Archer," the token gets renamed "Goblin Archer" so the initiative tracker knows which one's which.
- **Silent Swap When Only One Match Exists** — default off. When on, single-match cases skip the chooser. Default off means you ALWAYS see the chooser even for single matches — slower but full visibility.

## API

```js
const api = game.modules.get("ace-token-art").api;

// Force a folder rescan (after adding new art):
await api.rescanTokenArt();

// Inspect the full index:
api.getTokenArtIndex();

// Substring search:
api.searchTokenArt("elemental");
```

## License

MIT. Built by Sereptus-777.
