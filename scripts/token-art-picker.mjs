// ═══════════════════════════════════════════════════════════════════════════
//  ACE: Token Art — Manual Picker
// ───────────────────────────────────────────────────────────────────────────
//  A GM clicks a token, opens a big-portrait grid of EVERY art option from the
//  configured folders, and one click applies it. No waiting on the bio/auto
//  system. The pick persists on the token (texture.src lives on the token doc,
//  so it sticks even for unlinked tokens), and the actor is flagged skipAutoArt
//  so the slow auto-bio art flow won't override the manual choice on future drops.
//
//  Self-contained: talks to the ace-token-art PUBLIC API at runtime, registers
//  its own hooks, touches none of the engine internals. Entry points (any of):
//    • Token HUD button (select a token → the picture button on its HUD)
//    • Scene-control "Pick Token Art" tool (token tools, left toolbar)
//    • API: game.modules.get("ace-token-art").api.openPickerForControlled()
//    • Global: AceTokenArtPicker.openForControlled()   (macro-friendly)
// ═══════════════════════════════════════════════════════════════════════════

const MID = "ace-token-art";
const PICKER_BUILD = "1.0.12";   // shown in the header — if you don't see this number, the new file isn't loading

function _api() { return game.modules.get(MID)?.api ?? null; }

/** Art entries matching a name — searchTokenArt() first, raw index as fallback. */
function _queryArt(name) {
  const api = _api();
  const q = String(name ?? "").trim();
  let entries = [];
  try { const r = api?.searchTokenArt?.(q); if (Array.isArray(r)) entries = r; } catch (_) {}
  if (!entries.length) {
    try {
      const idx = api?.getTokenArtIndex?.();
      const all = idx?.all ?? [];
      const ql = q.toLowerCase().trim();
      if (!ql) {
        entries = all;
      } else {
        // Progressive fuzzy match — an exact/substring miss should still surface
        // the closest art instead of "no results". Tiers, best-first:
        //   100 full phrase · 60 all words (any order) · 40 first word · 20 any word.
        // (Johnny 2026-07-13: "Goblin Crookshank" with no exact hit should show
        //  every goblin — fall back to the first word.)
        const hay   = e => String(e.fullLower ?? e.fullName ?? e.path ?? "").toLowerCase();
        const words = ql.split(/\s+/).filter(Boolean);
        const first = words[0] ?? ql;
        const scored = [];
        for (const e of all) {
          const h = hay(e);
          let score = 0;
          if (h.includes(ql)) score = 100;
          else if (words.length > 1 && words.every(w => h.includes(w))) score = 60;
          else if (h.includes(first)) score = 40;
          else if (words.some(w => h.includes(w))) score = 20;
          if (score) scored.push({ e, score });
        }
        scored.sort((a, b) => b.score - a.score);
        entries = scored.map(s => s.e);
      }
    } catch (_) {}
  }
  return entries;
}

/**
 * Portrait lookup — a SEPARATE index over the portrait folders.
 * Deliberately never falls back to token art: a top-down token makes a
 * terrible portrait, and silently offering one would be worse than an
 * empty tab that tells you to set the folder.
 */
function _queryPortraits(name) {
  const api = _api();
  try {
    const r = api?.searchPortraitArt?.(String(name ?? "").trim());
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
}

export class TokenArtPicker {

  static _el = null;

  static register() {
    // ── Token HUD button (primary entry: click a token → its picture button) ──
    Hooks.on("renderTokenHUD", (hud, html) => {
      try {
        if (!game.user?.isGM) return;
        const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? null);
        if (!root) return;
        const col = root.querySelector(".col.left") ?? root.querySelector(".col.right") ?? root;
        if (!col || col.querySelector(".ace-tap-hud-btn")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "control-icon ace-tap-hud-btn";
        btn.title = "ACE — Pick Token Art";
        btn.innerHTML = `<i class="fas fa-images"></i>`;
        btn.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          TokenArtPicker.open(hud.object?.document ?? hud.object);
        });
        col.appendChild(btn);
      } catch (err) { console.warn(`${MID} | picker HUD button failed:`, err); }
    });

    // ── Scene-control tool (best-effort; handles V12 array + V13 object shapes) ──
    Hooks.on("getSceneControlButtons", (controls) => {
      try {
        if (!game.user?.isGM) return;
        const grp = Array.isArray(controls)
          ? controls.find(c => c?.name === "token" || c?.name === "tokens")
          : (controls?.tokens ?? controls?.token);
        if (!grp) return;
        const tool = {
          name: "ace-token-art-picker",
          title: "Pick Token Art",
          icon: "fas fa-images",
          button: true,
          visible: true,
          onClick: () => TokenArtPicker.openForControlled(),
          onChange: () => TokenArtPicker.openForControlled(),
        };
        if (Array.isArray(grp.tools)) {
          if (!grp.tools.some(t => t?.name === tool.name)) grp.tools.push(tool);
        } else if (grp.tools && typeof grp.tools === "object") {
          grp.tools[tool.name] = tool;
        }
      } catch (err) { console.warn(`${MID} | picker scene control failed:`, err); }
    });

    // ── Public API + global (macro-friendly, survives even if buttons don't render) ──
    try {
      const mod = game.modules.get(MID);
      if (mod) {
        mod.api = mod.api ?? {};
        mod.api.openPicker = (t) => TokenArtPicker.open(t);
        mod.api.openPickerForControlled = () => TokenArtPicker.openForControlled();
      }
    } catch (_) {}
    try { globalThis.AceTokenArtPicker = TokenArtPicker; } catch (_) {}

    console.log(`${MID} | Manual Token Art Picker ready — HUD button + scene control + AceTokenArtPicker.openForControlled().`);
  }

  static openForControlled() {
    const tk = canvas.tokens?.controlled?.[0];
    if (!tk) { ui.notifications?.warn("Select a token first, then open the Token Art picker."); return; }
    TokenArtPicker.open(tk.document ?? tk);
  }

  static open(tokenLike) {
    try {
      if (!game.user?.isGM) { ui.notifications?.warn("Token Art picker is GM-only."); return; }
      const tokenDoc = tokenLike?.document ?? tokenLike;
      if (!tokenDoc?.update) { ui.notifications?.warn("No token to pick art for."); return; }
      TokenArtPicker.close();
      const baseName = tokenDoc.actor?.name ?? tokenDoc.name ?? "";
      TokenArtPicker._render(tokenDoc, baseName);
    } catch (err) { console.error(`${MID} | picker open failed:`, err); }
  }

  static close() {
    try { TokenArtPicker._el?.remove(); } catch (_) {}
    TokenArtPicker._el = null;
    try { document.removeEventListener("keydown", TokenArtPicker._onKey, true); } catch (_) {}
  }

  static _onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); TokenArtPicker.close(); }
  }

  static _render(tokenDoc, query) {
    // Which tab is live. Declared FIRST so every handler below closes over an
    // already-initialised binding — no temporal-dead-zone surprises.
    let _mode = "token";              // "token" (texture.src) | "portrait" (actor.img)
    const _run = (q) => (_mode === "portrait" ? _queryPortraits(q) : _queryArt(q));

    // ── Backdrop ──
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", zIndex: "100000",
      background: "rgba(0,0,0,0.55)", display: "flex",
      alignItems: "center", justifyContent: "center",
    });
    backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) TokenArtPicker.close(); });

    // ── Panel ──
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(94vw, 1200px)", height: "min(88vh, 880px)",
      display: "flex", flexDirection: "column",
      background: "linear-gradient(180deg,#15110d 0%,#0c0a08 100%)",
      border: "2px solid #d4af37", borderRadius: "10px",
      boxShadow: "0 12px 44px rgba(0,0,0,0.72)", color: "#f0e4c0",
      fontFamily: "'Signika','Helvetica Neue',sans-serif", overflow: "hidden",
    });
    panel.addEventListener("mousedown", (ev) => ev.stopPropagation());

    // ── Header ──
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", alignItems: "center", gap: "12px",
      padding: "14px 16px", borderBottom: "1px solid #4a3a28",
      background: "linear-gradient(180deg,#1d1710,#15110d)",
    });
    header.innerHTML = `<i class="fas fa-images" style="color:#d4af37;font-size:20px;"></i>
      <div style="font-size:18px;font-weight:700;color:#d4af37;letter-spacing:.5px;">TOKEN ART <span style="font-size:11px;color:#7a6a48;font-weight:500;">v${PICKER_BUILD}</span></div>`;
    const nameEl = document.createElement("div");
    Object.assign(nameEl.style, { fontSize: "15px", color: "#c9b48a" });
    nameEl.textContent = tokenDoc.name ?? "";
    header.appendChild(nameEl);

    // ── Tabs: Token Art | Portrait ──
    const tabs = document.createElement("div");
    Object.assign(tabs.style, { display: "flex", gap: "6px", marginLeft: "18px" });
    const mkTab = (id, label, icon) => {
      const t = document.createElement("button");
      t.type = "button"; t.dataset.mode = id;
      t.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
      Object.assign(t.style, {
        fontSize: "14px", padding: "7px 14px", borderRadius: "6px", cursor: "pointer",
        border: "1px solid #6b5530", background: "#0c0a08", color: "#c9b48a",
        display: "flex", alignItems: "center", gap: "7px", fontWeight: "600",
      });
      t.addEventListener("click", () => {
        if (_mode === id) return;
        _mode = id; _page = 0;
        syncTabs();
        // The save-as-default line says different things for a portrait and a
        // token, so it has to follow the tab.
        try { TokenArtPicker._syncDefaultsText?.(); } catch (_) {}
        search.placeholder = id === "portrait" ? "Search portraits by name…" : "Search art by name…";
        paint(_run(search.value));
      });
      tabs.appendChild(t);
      return t;
    };
    const tabToken    = mkTab("token", "Token Art", "fa-chess-pawn");
    const tabPortrait = mkTab("portrait", "Portrait", "fa-user");
    const syncTabs = () => {
      for (const t of [tabToken, tabPortrait]) {
        const on = t.dataset.mode === _mode;
        t.style.background  = on ? "#d4af37" : "#0c0a08";
        t.style.color       = on ? "#15110d" : "#c9b48a";
        t.style.borderColor = on ? "#f0d98a" : "#6b5530";
      }
    };
    header.appendChild(tabs);

    const search = document.createElement("input");
    search.type = "text"; search.value = query ?? ""; search.placeholder = "Search art by name…";
    Object.assign(search.style, {
      marginLeft: "auto", width: "260px", fontSize: "15px", padding: "7px 10px",
      borderRadius: "6px", border: "1px solid #6b5530", background: "#0c0a08", color: "#f0e4c0",
    });
    header.appendChild(search);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.innerHTML = `<i class="fas fa-times"></i>`;
    Object.assign(closeBtn.style, {
      fontSize: "17px", background: "transparent", border: "none", color: "#c9b48a", cursor: "pointer", padding: "4px 8px",
    });
    closeBtn.addEventListener("click", () => TokenArtPicker.close());
    header.appendChild(closeBtn);

    // ── Grid (big thumbnails) ──
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      flex: "1", overflowY: "auto", padding: "16px", display: "grid", gap: "14px",
      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", alignContent: "start",
    });

    // ── "Save as the default" bar ──────────────────────────────────────
    // Built ONCE and kept outside the footer, because renderPage() wipes the
    // footer on every search and page turn — a checkbox in there would reset
    // itself mid-browse.
    //
    // Ticked by default: setting a creature's art almost always means "this is
    // what this creature looks like", and having to re-pick after every drop
    // was the complaint. Untick it for a genuine one-off — the cracked-face
    // golem that shouldn't change what the next nine look like.
    const defaultsBar = document.createElement("label");
    Object.assign(defaultsBar.style, {
      display: "flex", alignItems: "center", gap: "10px",
      padding: "10px 16px", borderTop: "1px solid #4a3a28",
      background: "#141210", color: "#e9dcb0", fontSize: "15px", cursor: "pointer",
    });
    const defaultsBox = document.createElement("input");
    defaultsBox.type = "checkbox";
    defaultsBox.id = "ace-ta-save-default";
    defaultsBox.checked = true;
    Object.assign(defaultsBox.style, { width: "18px", height: "18px", cursor: "pointer" });
    const defaultsText = document.createElement("span");
    defaultsBar.appendChild(defaultsBox);
    defaultsBar.appendChild(defaultsText);

    // ── Footer (result count + pager) ──
    const footer = document.createElement("div");
    Object.assign(footer.style, {
      padding: "8px 16px", borderTop: "1px solid #4a3a28", fontSize: "13px", color: "#9c8a64",
      display: "flex", alignItems: "center", gap: "12px",
    });

    // ── Paging state — big thumbnails, paged so hundreds of results never squish ──
    //
    // ⚠️🔴 SIXTY WAS SIXTY DOWNLOADS. Johnny, 2026-08-23: "it does not have to
    // draw 60 images per page. That is way too fucking many. 10 images per page
    // is fine at most, because usually the one you are looking for is in the
    // very first five."
    //
    // He is right, and the cost was never the paging, it was that every tile
    // fetches the FULL-SIZE original and shrinks it into a 280px box. The index
    // cache cannot help with that — it stores paths, not pixels — so sixty tiles
    // meant sixty full-size images across a browser connection pool of about
    // six. This is a picker used mid-session, with players connected, to change
    // a token RIGHT NOW. Fifteen seconds to become usable means it does not get
    // used at all.
    const PER_PAGE = 10;
    let _list = [];
    let _page = 0;

    // Set styles with !important so NO external module CSS (BG3 HUD, portrait tweaks,
    // Foundry core img rules, etc.) can override our cell dimensions or force
    // object-fit:cover — that was flattening the cells + cropping the art to a band.
    const _imp = (el, props) => {
      for (const [k, v] of Object.entries(props)) {
        const prop = k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        try { el.style.setProperty(prop, v, "important"); } catch (_) { el.style[k] = v; }
      }
    };

    const _card = (entry) => {
      const card = document.createElement("div");
      Object.assign(card.style, {
        cursor: "pointer", borderRadius: "8px", overflow: "hidden",
        border: "2px solid transparent", background: "#0c0a08",
        transition: "border-color .12s, transform .12s",
      });
      _imp(card, { display: "flex", flexDirection: "column", height: "280px" });
      const imgWrap = document.createElement("div");
      Object.assign(imgWrap.style, { background: "#000", display: "flex", alignItems: "center", justifyContent: "center" });
      _imp(imgWrap, { flex: "1 1 auto", minHeight: "0", width: "100%" });
      const img = document.createElement("img");
      // ⚠️ THE PATH IS PARKED, NOT ASSIGNED. Setting src here starts the fetch
      // for every tile at the same instant, so the browser runs six at once and
      // they arrive in whatever order the disk finishes them — the first tile,
      // the one he is actually looking at, competes with nine others and can
      // land last. _fillImages below assigns them in reading order instead.
      img.dataset.aceSrc = entry.path;
      // ⚠️🔴 NO loading="lazy" HERE, AND THAT IS DELIBERATE (2026-08-23).
      //
      // Lazy loading and an explicit ordered loader are two throttles fighting
      // each other. Worse, a lazily-deferred image fires NEITHER load NOR
      // error, and _fillImages advances on those events — so a single deferred
      // tile would stall every remaining tile on the page, permanently, with no
      // error anywhere. Proven in a real browser: images inside a container the
      // engine has not decided is "visible" simply never load.
      //
      // With ten tiles and the loader below controlling the order, the loader
      // IS the throttle. Lazy has nothing left to contribute and one way to
      // break it.
      img.decoding = "async";
      img.addEventListener("error", () => { img.style.opacity = "0.2"; });
      _imp(img, { width: "100%", height: "100%", objectFit: "contain", maxWidth: "none", maxHeight: "none", border: "none", borderRadius: "0" });
      imgWrap.appendChild(img);
      const lbl = document.createElement("div");
      Object.assign(lbl.style, { padding: "6px 8px", fontSize: "13px", color: "#e9dcb0", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      _imp(lbl, { flex: "0 0 auto" });
      // FULL art name (e.g. "Goblin Minion 01") — not the parsed variant, which drops the
      // base and reads as a confusing "Minion 01". title = same, so hover shows the full name.
      lbl.textContent = entry.fullName || entry.displayVariant || entry.displayBase || "art";

      // ── Hover tells you WHICH FILE this actually is ──────────────────────
      // Johnny, 2026-08-11: "when I hover over the portrait, I want to be able
      // to see the file name and the path."
      // The label is a prettified art NAME ("Goblin Minion 01"), which is not
      // enough to go and find the file, rename it, or work out which of two
      // near-identical images you are looking at. The tooltip carries the real
      // filename and the folder it came from.
      // ⚠️ Put it on the CARD, not just the label — the label is a thin strip
      // at the bottom and the thing people hover is the picture.
      const _tip = (() => {
        try {
          const full = String(entry.path ?? "");
          const file = decodeURIComponent(full.split("/").pop() ?? "");
          const dir  = decodeURIComponent(full.slice(0, full.lastIndexOf("/")) || "");
          return `${lbl.textContent}
${file}
${dir}`;
        } catch (_) { return lbl.textContent; }
      })();
      lbl.title = _tip;
      card.title = _tip;
      imgWrap.title = _tip;
      img.title = _tip;

      card.appendChild(imgWrap); card.appendChild(lbl);
      card.addEventListener("mouseenter", () => { card.style.borderColor = "#d4af37"; card.style.transform = "translateY(-2px)"; });
      card.addEventListener("mouseleave", () => { card.style.borderColor = "transparent"; card.style.transform = "none"; });
      card.addEventListener("click", () => {
        const saveDefault = document.getElementById("ace-ta-save-default")?.checked !== false;
        return _mode === "portrait"
          ? TokenArtPicker._applyPortrait(tokenDoc, entry, { saveDefault })
          : TokenArtPicker._apply(tokenDoc, entry, { saveDefault });
      });
      return card;
    };

    const _navBtn = (label, disabled, onClick) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      Object.assign(b.style, {
        fontSize: "13px", padding: "5px 12px", borderRadius: "6px", border: "1px solid #6b5530",
        background: disabled ? "#0c0a08" : "#1d1710", color: disabled ? "#5c503a" : "#e9dcb0",
        cursor: disabled ? "default" : "pointer",
      });
      b.disabled = disabled;
      if (!disabled) b.addEventListener("click", onClick);
      return b;
    };

    // ── ⚠️ LOAD IN READING ORDER, NOT ALL AT ONCE (2026-08-23) ──────────────
    //
    // Johnny: "It seems to download every image that it finds and downloads all
    // at the same time. Can we not have it so it downloads at least the first 10,
    // the first sort of thing?"
    //
    // Exactly right. Ten simultaneous requests share the connection pool and
    // complete in whatever order the disk returns them, so the top-left tile —
    // the one he is looking at, and usually the one he wants — has no priority
    // at all and frequently arrives last. Feeding them in order gives the first
    // tiles the bandwidth, so the grid fills top to bottom the way it is read.
    //
    // TWO AT A TIME, not one: strictly serial would leave the pipe idle during
    // each round trip and drag the tail out for no benefit. Two keeps the first
    // tile essentially as fast as it can be while the rest still overlap.
    //
    // ⚠️ IT MUST BE CANCELLABLE. Without the generation check, clicking Next
    // while page one is still filling leaves the old page's downloads competing
    // with the new page's for the same six connections — so the page he is
    // actually looking at gets slower the more he pages around, which is the
    // opposite of the point.
    let _fillGeneration = 0;
    const _fillImages = (gridEl) => {
      const mine = ++_fillGeneration;
      const pending = [...gridEl.querySelectorAll("img[data-ace-src]")];
      let next = 0;

      const startOne = () => {
        if (mine !== _fillGeneration) return;          // page changed — abandon
        if (next >= pending.length) return;
        const img = pending[next++];
        const src = img.dataset.aceSrc;
        if (!src) { startOne(); return; }
        delete img.dataset.aceSrc;

        // ⚠️ ALWAYS ADVANCE, on success OR failure. A missing file that never
        // fires load would otherwise stall the whole column behind it and look
        // exactly like the slowness this change exists to remove.
        // ⚠️ ALWAYS ADVANCE — on success, on failure, OR on a timeout. The
        // first two are the normal paths. The third exists because an image can
        // end up in a state where it fires neither event at all, and a chain
        // that waits forever on one tile is indistinguishable from the original
        // slowness. Nothing in this loader may depend on an event arriving.
        let advanced = false;
        const advance = () => {
            if (advanced) return;
            advanced = true;
            clearTimeout(stall);
            startOne();
        };
        const stall = setTimeout(advance, 6000);
        img.addEventListener("load",  advance, { once: true });
        img.addEventListener("error", advance, { once: true });
        img.src = src;
      };

      const LANES = 2;
      for (let i = 0; i < LANES; i++) startOne();
    };

    const renderPage = () => {
      grid.innerHTML = "";
      footer.innerHTML = "";
      if (!_list.length) {
        const empty = document.createElement("div");
        Object.assign(empty.style, { gridColumn: "1/-1", textAlign: "center", color: "#9c8a64", padding: "44px", fontSize: "16px" });
        empty.textContent = _mode === "portrait"
          ? "No portraits found. Set 'Portrait Art Folders' in the module settings, then rescan."
          : "No art found. Check your Token Art folders in settings, or rescan.";
        grid.appendChild(empty);
        footer.textContent = "0 results";
        return;
      }
      const pages = Math.max(1, Math.ceil(_list.length / PER_PAGE));
      _page = Math.min(Math.max(0, _page), pages - 1);
      const start = _page * PER_PAGE;
      for (const entry of _list.slice(start, start + PER_PAGE)) grid.appendChild(_card(entry));
      try { grid.scrollTop = 0; } catch (_) {}
      _fillImages(grid);

      // Footer: result range on the left, pager on the right.
      const count = document.createElement("div");
      count.style.color = "#9c8a64";
      count.textContent = `${_list.length} result${_list.length === 1 ? "" : "s"} — showing ${start + 1}–${Math.min(_list.length, start + PER_PAGE)}. Click to apply (sticks on this token, even unlinked).`;
      footer.appendChild(count);
      const nav = document.createElement("div");
      Object.assign(nav.style, { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px", flex: "0 0 auto" });
      nav.appendChild(_navBtn("‹ Prev", _page <= 0, () => { _page--; renderPage(); }));
      const ind = document.createElement("div");
      Object.assign(ind.style, { fontSize: "13px", color: "#c9b48a", minWidth: "92px", textAlign: "center" });
      ind.textContent = `Page ${_page + 1} / ${pages}`;
      nav.appendChild(ind);
      nav.appendChild(_navBtn("Next ›", _page >= pages - 1, () => { _page++; renderPage(); }));
      footer.appendChild(nav);
    };


    const paint = (list) => {
      _list = Array.isArray(list) ? list : [];
      _page = 0;
      renderPage();
    };

    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => paint(_run(search.value)), 180);
    });

    // ── Draggable by the header (grab + move like a normal window) ──
    // On first grab we switch the panel from flex-centered to position:fixed at its
    // current spot (no jump), then follow the mouse. Move/up live on the full-screen
    // backdrop, so they're torn down automatically when close() removes it.
    header.style.cursor = "move";
    let _drag = null;
    header.addEventListener("mousedown", (ev) => {
      if (ev.target.closest("input, button")) return;   // let the search box + close button work
      const rect = panel.getBoundingClientRect();
      Object.assign(panel.style, { position: "fixed", margin: "0", left: `${rect.left}px`, top: `${rect.top}px` });
      _drag = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, w: rect.width, h: rect.height };
      ev.preventDefault();
    });
    backdrop.addEventListener("mousemove", (ev) => {
      if (!_drag) return;
      const x = Math.max(80 - _drag.w, Math.min(ev.clientX - _drag.dx, window.innerWidth - 80));
      const y = Math.max(0, Math.min(ev.clientY - _drag.dy, window.innerHeight - 40));
      panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    });
    backdrop.addEventListener("mouseup", () => { _drag = null; });

    // Wording follows the tab, and names the creature so there's no doubt
    // about what "future ones" means.
    const _worldName = TokenArtPicker._worldActorFor(tokenDoc)?.name ?? "this creature";
    const syncDefaultsText = () => {
      defaultsText.textContent = _mode === "portrait"
        ? `Also save as the portrait for ${_worldName} in your actors list`
        : `Also save as the default art for future ${_worldName}s`;
    };
    syncDefaultsText();
    TokenArtPicker._syncDefaultsText = syncDefaultsText;

    panel.appendChild(header);
    panel.appendChild(grid);
    panel.appendChild(defaultsBar);
    panel.appendChild(footer);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    TokenArtPicker._el = backdrop;
    try { document.addEventListener("keydown", TokenArtPicker._onKey, true); } catch (_) {}
    try { search.focus(); } catch (_) {}

    syncTabs();
    paint(_run(query));
  }

  /**
   * The actor in the ACTORS LIST behind this token — never the token's own
   * private copy, and never a compendium entry.
   *
   * ⚠️ `tokenDoc.actor` on an UNLINKED token is a synthetic actor whose writes
   * land in that token's delta. Portraits were being written there and so never
   * reached the sidebar: the intent was always "set it on the actor" (Johnny,
   * 2026-08-06), but on the unlinked tokens that make up nearly every NPC it
   * silently only ever set it on that one token. (Found + fixed 2026-08-08.)
   *
   * Returns null when there is no world actor, or when the actor lives in a
   * compendium — packs stay pristine, and that is a rule, not a setting.
   */
  static _worldActorFor(tokenDoc) {
    const world = game.actors?.get(tokenDoc?.actorId) ?? null;
    if (!world) return null;
    if (world.pack) return null;      // compendium — never written to
    return world;
  }

  /**
   * Portrait pick -> the ACTOR's profile image, so it survives reloads and
   * shows everywhere the actor does.
   */
  static async _applyPortrait(tokenDoc, entry, opts = {}) {
    try {
      const world = TokenArtPicker._worldActorFor(tokenDoc);
      const saveDefault = opts.saveDefault !== false;
      const tokenActor = tokenDoc?.actor;

      if (!world && !tokenActor) {
        ui.notifications?.warn("No actor behind this token — can't set a portrait.");
        return;
      }

      // The actors-list entry is the point of a portrait. Fall back to the
      // token's own copy only when there genuinely isn't one to write to.
      const target = (saveDefault && world) ? world : tokenActor;
      await target.update({ img: entry.path });

      const art = entry.fullName || entry.file || "image";
      if (saveDefault && world) {
        ui.notifications?.info(`Portrait set for ${world.name} in your actors list: ${art}`);
      } else if (world) {
        ui.notifications?.info(`Portrait set on this token only: ${art}. ${world.name} in your actors list is unchanged.`);
      } else {
        ui.notifications?.info(`Portrait set on this token: ${art}. (No actors-list entry to save it to — this one may have come from a compendium.)`);
      }
      TokenArtPicker.close();
    } catch (err) {
      console.error(`${MID} | portrait apply failed:`, err);
      ui.notifications?.error("Failed to set the portrait (see console).");
    }
  }

  /**
   * Token art pick -> the token in front of you, so you see it immediately,
   * AND (unless unticked) the actor's prototype token, so the next one you
   * drag out already looks right instead of needing the same edit nine times.
   */
  static async _apply(tokenDoc, entry, opts = {}) {
    try {
      const saveDefault = opts.saveDefault !== false;
      await tokenDoc.update({ "texture.src": entry.path });
      // Keep the slow auto-bio art flow from overwriting this manual pick later.
      try { await tokenDoc.actor?.setFlag(MID, "skipAutoArt", true); } catch (_) {}

      const art = entry.fullName || entry.displayVariant || "art";
      let savedTo = null;
      if (saveDefault) {
        const world = TokenArtPicker._worldActorFor(tokenDoc);
        if (world) {
          // Only the deliberate pick you just made writes back. Automatic art
          // and random variants never call this path — otherwise whichever
          // variant happened to land last would become the species default.
          await world.update({ "prototypeToken.texture.src": entry.path });
          savedTo = world.name;
        }
      }

      ui.notifications?.info(savedTo
        ? `Token art set — and saved as the default for future ${savedTo}s.`
        : `Token art set on this token only: ${art}.`);
      TokenArtPicker.close();
    } catch (err) {
      console.error(`${MID} | picker apply failed:`, err);
      ui.notifications?.error("Failed to apply token art (see console).");
    }
  }
}

Hooks.once("ready", () => {
  try { TokenArtPicker.register(); }
  catch (err) { console.error(`${MID} | Token Art Picker register failed:`, err); }
});
