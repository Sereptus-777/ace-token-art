// ═══════════════════════════════════════════════════════════════════════════
//  ACE Token Art — THE SCALE THE SHEET SHOWS IS THE SCALE ON THE MAP
// ───────────────────────────────────────────────────────────────────────────
//  ⚠️ 2026-09-26, his spec. Foundry's Update Token does not reliably write
//  texture.scaleX / scaleY onto a PLACED token: the sheet shows 1.5, the token
//  on the map does not move, and the only way to make it take was a console
//  snippet with { diff: false }.
//
//  Why diff matters: an update is normally diffed against the document, and a
//  scale that the document believes it already holds is dropped before it ever
//  reaches the canvas. `{ diff: false }` sends it regardless.
//
//  Two ways in, both writing the same two numbers the slider shows:
//
//    1. The token config's own submit. After Foundry has run its update, the
//       scale from THAT form is written again, undiffed.
//    2. An "Apply scale" button on the token HUD, which takes the scale off the
//       creature's own sheet and puts it on the token under the cursor.
//
//  ⚠️ WHAT THIS MUST NOT DO, from his spec, verbatim: do not force 1, do not
//  change width or height, do not touch glow, combat, bios or loot. It writes
//  texture.scaleX and texture.scaleY and nothing else, ever.
// ═══════════════════════════════════════════════════════════════════════════

const TAG = "ace-token-art";

export class TokenScaleWrite {

  static register() {
    Hooks.on("renderTokenConfig", TokenScaleWrite._onConfigRender);
    Hooks.on("renderTokenHUD",    TokenScaleWrite._onHudRender);
    console.log(`${TAG} | token scale write armed: the sheet's scale reaches the map.`);
  }

  /* ══════════════════════════════════════════════════════════════════════
     1. THE CONFIG'S OWN SUBMIT
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * ⚠️ Only a PLACED token. A prototype config edits the actor's own template,
   * which has no token on the map to write to and is not what is broken.
   * `renderPrototypeTokenConfig` is a different hook, so this never sees one,
   * and the parent check is the belt to that braces.
   */
  static _onConfigRender(app, html) {
    const doc = app?.document;
    if (!doc?.parent) return;                       // not a placed token
    const root = html?.jquery ? html[0] : html;
    const form = root?.tagName === "FORM" ? root : root?.querySelector?.("form");
    if (!form) {
      console.warn(`${TAG} | the token config has no form to listen to — scale write skipped.`);
      return;
    }
    if (form.dataset.aceScaleWired === "1") return;
    form.dataset.aceScaleWired = "1";

    form.addEventListener("submit", () => {
      // Read the numbers while the form is still on screen. Foundry turns
      // `scale` + the mirror ticks into texture.scaleX/scaleY; this reads the
      // same three fields and does the same arithmetic, so what lands on the
      // token is exactly what the slider said.
      const read = (name) => form.querySelector(`[name="${name}"]`);
      const scaleEl = read("scale");
      if (!scaleEl) return;                          // a build without the field
      const scale = Number(scaleEl.value);
      if (!Number.isFinite(scale)) return;
      const mirrorX = !!read("mirrorX")?.checked;
      const mirrorY = !!read("mirrorY")?.checked;

      // After Foundry's own update has been and gone.
      setTimeout(() => TokenScaleWrite.write(doc, {
        scaleX: scale * (mirrorX ? -1 : 1),
        scaleY: scale * (mirrorY ? -1 : 1),
      }, "Update Token"), 120);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. THE HUD BUTTON
     ══════════════════════════════════════════════════════════════════════ */

  static _onHudRender(hud, html) {
    const token = hud?.object;
    const doc = token?.document;
    if (!doc || !game.user.isGM) return;
    const root = html?.jquery ? html[0] : html;
    const col = root?.querySelector?.(".col.right") ?? root?.querySelector?.(".right");
    if (!col) return;
    if (col.querySelector(".ace-apply-scale")) return;

    const proto = doc.actor?.prototypeToken?.texture;
    if (!proto) return;
    const sx = Number(proto.scaleX ?? 1);
    const sy = Number(proto.scaleY ?? 1);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "control-icon ace-apply-scale";
    btn.title = `Apply scale ${Math.abs(sx)} from ${doc.actor?.name ?? "the sheet"}`;
    btn.innerHTML = `<i class="fas fa-up-right-and-down-left-from-center"></i>`;
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await TokenScaleWrite.write(doc, { scaleX: sx, scaleY: sy }, "Apply scale");
    });
    col.appendChild(btn);
  }

  /* ══════════════════════════════════════════════════════════════════════
     THE WRITE ITSELF — the only place either route touches a token
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * @param {TokenDocument} doc
   * @param {{scaleX:number, scaleY:number}} scale
   * @param {string} why   for the log, so nothing here happens in silence
   */
  static async write(doc, { scaleX, scaleY }, why = "") {
    if (!doc) return false;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
      console.warn(`${TAG} | ${why}: the scale was not a number, so nothing was written.`);
      return false;
    }
    try {
      // ⚠️ diff: false is the whole point. Two numbers, nothing else.
      await doc.update({ texture: { scaleX, scaleY } }, { diff: false });
      console.log(`${TAG} | ${why}: ${doc.name} is at ${scaleX} × ${scaleY} on the map.`);
      return true;
    } catch (err) {
      console.error(`${TAG} | ${why}: the scale could not be written to ${doc.name}:`, err);
      ui.notifications?.error(`ACE: Token Art — could not set the scale on ${doc.name}. See the console.`);
      return false;
    }
  }
}
