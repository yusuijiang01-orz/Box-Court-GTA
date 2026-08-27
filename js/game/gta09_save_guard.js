/* =============================================================
   js/game/gta09_save_guard.js — GTA-09 restore ordering guard

   Keeps Continue from tripping the New Game overwrite confirmation and
   suppresses autosave hooks while a stored state is being restored.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game || !TOWN.SaveGame) return;

  const Game = TOWN.Game;
  const S = TOWN.SaveGame;
  const SAVE_KEY = 'box-court-gta.save.v1';

  function installSaveGuard() {
    if (S.__restoreGuardInstalled) return;
    S.__restoreGuardInstalled = true;
    S.restoring = false;

    const baseSave = S.save;
    S.save = function () {
      if (S.restoring) return false;
      return baseSave.apply(S, arguments);
    };

    const baseRestore = S.restore;
    S.restore = function () {
      S.restoring = true;
      try {
        return baseRestore.apply(S, arguments);
      } finally {
        S.restoring = false;
      }
    };
  }

  function replaceContinueHandler() {
    const oldBtn = document.getElementById('btn-continue');
    const startBtn = document.getElementById('btn-start');
    if (!oldBtn || !startBtn || oldBtn.dataset.gta09Guard === '1') return;

    // Clone removes the first GTA-09 anonymous click listener cleanly.
    const btn = oldBtn.cloneNode(true);
    btn.dataset.gta09Guard = '1';
    oldBtn.replaceWith(btn);
    S.els.continueBtn = btn;

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      let raw = null;
      try { raw = global.localStorage && global.localStorage.getItem(SAVE_KEY); }
      catch (_) {}
      if (!raw) return;

      // The shell already owns the real Play transition. Temporarily hiding the
      // save lets us reuse that transition without the New Game confirmation
      // treating Continue as an overwrite request.
      S.pendingRestore = true;
      let removed = false;
      try {
        global.localStorage.removeItem(SAVE_KEY);
        removed = true;
        startBtn.click();
      } finally {
        try {
          if (removed) global.localStorage.setItem(SAVE_KEY, raw);
        } catch (_) {}
      }

      global.requestAnimationFrame(function () {
        global.requestAnimationFrame(function () { S.restore(); });
      });
    });
  }

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    installSaveGuard();
    replaceContinueHandler();
    return out;
  };
})(window);
