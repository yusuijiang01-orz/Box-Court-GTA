/* =============================================================
   GTA-08C steering direction hotfix

   The GTA-02 vehicle yaw convention is opposite to the screen-left/right
   sign used by GTA-08C's touch steering buttons. Flip only the touch-drive
   steering value after GTA-08C has produced it. Desktop WASD is untouched.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Input || !TOWN.Vehicles || !TOWN.GTA08C) return;

  const Input = TOWN.Input;
  const V = TOWN.Vehicles;
  const C = TOWN.GTA08C;

  if (Input.prototype.update.__gta08cSteerFixed) return;

  const baseUpdate = Input.prototype.update;
  const fixedUpdate = function (dt) {
    baseUpdate.call(this, dt);
    const driving = !!(V.STATES && V.state === V.STATES.DRIVING && V.current && V.current.car);
    if (C.touchCapable && driving && this.state && this.state.move) {
      this.state.move.x = -this.state.move.x;
    }
  };

  fixedUpdate.__gta08cSteerFixed = true;
  Input.prototype.update = fixedUpdate;
  console.log('[GTA-08C] touch steering direction fixed');
})(window);
