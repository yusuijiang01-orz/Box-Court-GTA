/* =============================================================
   js/game/gta10_brand.js — GTA-10 brand rename

   Presentation-only branding. Keeps legacy save keys unchanged so
   existing GTA-09 local saves remain compatible.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const BRAND = '给他爱There';

  const B = TOWN.GTA10 = {
    version: 'GTA-10.1',
    name: BRAND,
    initialized: false,
  };

  function setText(sel, text) {
    const el = document.querySelector(sel);
    if (el) el.textContent = text;
  }

  function applyBrand() {
    document.title = BRAND;
    setText('#loading .load-title', BRAND);
    setText('#loading .load-sub', 'OPEN WORLD ACTION');
    setText('#titlecard h1', BRAND);
    setText('#titlecard p', '海港 · 驾驶 · 枪战 · 通缉');

    const start = document.getElementById('start-screen');
    if (start) {
      setText('#start-screen .screen-eyebrow', 'OPEN WORLD ACTION');
      setText('#start-screen .screen-title', BRAND);
      setText('#start-screen .screen-sub', '海港 · 驾驶 · 枪战 · 通缉');
    }
  }

  function installScreenshotOverride() {
    const oldBtn = document.getElementById('set-shot');
    if (!oldBtn || oldBtn.dataset.gta10Brand === '1') return;

    // shell.js owns the original anonymous click handler. Clone the button so
    // the old Diorama Town filename handler is removed without touching shell.
    const btn = oldBtn.cloneNode(true);
    btn.dataset.gta10Brand = '1';
    oldBtn.replaceWith(btn);

    btn.addEventListener('click', function () {
      const Stage = TOWN.Stage;
      if (!Stage || !Stage.renderer || !Stage.scene || !Stage.camera) return;
      const r = Stage.renderer;
      r.render(Stage.scene, Stage.camera);
      let url;
      try { url = r.domElement.toDataURL('image/png'); }
      catch (_) { return; }

      const h = TOWN.App && isFinite(TOWN.App.hours) ? TOWN.App.hours : 0;
      const hh = String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0');
      const mm = String(Math.floor((h - Math.floor(h)) * 60 + 0.0001)).padStart(2, '0');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gei-ta-ai-there-' + hh + mm + '.png';
      a.click();
    });
  }

  B.init = function () {
    if (B.initialized) return;
    B.initialized = true;
    applyBrand();
    installScreenshotOverride();
    console.log('[GTA-10] brand ready:', BRAND);
  };

  // Static loading/title DOM already exists when this script executes.
  applyBrand();

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    B.init();
    return out;
  };
})(window);
