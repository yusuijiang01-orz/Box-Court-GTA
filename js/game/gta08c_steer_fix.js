/* =============================================================
   GTA-08C steering direction hotfix v2

   GTA-08C installs its touch-input wrapper during Game.init(), so the old
   hotfix ran too early and was overwritten. Install this correction only
   AFTER the full Game.init chain has completed. Desktop WASD is untouched.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game || !TOWN.Input || !TOWN.Vehicles || !TOWN.GTA08C) return;

  const Game = TOWN.Game;
  const Input = TOWN.Input;
  const V = TOWN.Vehicles;
  const C = TOWN.GTA08C;

  function installFinalSteerFix() {
    const current = Input.prototype.update;
    if (!current || current.__gta08cSteerFixedV2) return;

    const fixed = function (dt) {
      current.call(this, dt);
      const driving = !!(V.STATES && V.state === V.STATES.DRIVING && V.current && V.current.car);
      if (C.touchCapable && driving && this.state && this.state.move) {
        // GTA-02 positive steer turns screen-left from the chase-camera view.
        // GTA-08C produces right=+1 / left=-1, so invert once at the FINAL
        // input stage: left becomes +1 and right becomes -1.
        this.state.move.x = -this.state.move.x;
      }
    };
    fixed.__gta08cSteerFixedV2 = true;
    Input.prototype.update = fixed;
    console.log('[GTA-08C] final touch steering direction fixed');
  }

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    installFinalSteerFix();
    return out;
  };

  // Defensive path for environments where Game.init already ran before this
  // script executed (hot reload / dev injection).
  if (C.initialized) installFinalSteerFix();
})(window);
