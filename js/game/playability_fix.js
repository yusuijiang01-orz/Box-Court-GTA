/* =============================================================
   js/game/playability_fix.js — mobile input + locomotion tuning

   Small compatibility layer retained from phone testing:
   - mobile hold-to-run must survive the keyboard fold each frame;
   - base walk/run speeds are raised to match the world scale.

   Reachability / collision work now belongs to GTA Collision v1.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN) return;

  // Mobile run: input.js' keyboard fold clears state.run whenever Shift is not
  // held. Preserve the touch hold state after that fold has run.
  if (TOWN.Input && !TOWN.Input.prototype.__mobileRunFix) {
    const originalInputUpdate = TOWN.Input.prototype.update;
    if (typeof originalInputUpdate === 'function') {
      TOWN.Input.prototype.update = function (dt) {
        const touchRunHeld = !!(this._held && this._held.run);
        originalInputUpdate.call(this, dt);
        if (touchRunHeld || (this._held && this._held.run)) {
          this.state.run = true;
        }
      };
      TOWN.Input.prototype.__mobileRunFix = true;
    }
  }

  // Locomotion scale: keep acceleration/animation/collision behavior, only
  // raise the two target speeds. Desktop Shift and mobile hold share values.
  if (TOWN.Player && !TOWN.Player.__speedFix) {
    const originalPlayerUpdate = TOWN.Player.update;
    if (typeof originalPlayerUpdate === 'function') {
      TOWN.Player.update = function (st, input, camera, dt, et) {
        if (st) {
          st.walkSpeed = 3.8;
          st.runSpeed = 7.4;
        }
        return originalPlayerUpdate.call(TOWN.Player, st, input, camera, dt, et);
      };
      TOWN.Player.__speedFix = true;
    }
  }

  console.log('[TOWN] playability fix v2 ready');
})(window);
