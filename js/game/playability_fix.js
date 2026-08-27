/* =============================================================
   js/game/playability_fix.js — mobile/input + GTA-01 reachability hotfix

   Keeps the stable Island.sample grounding introduced by ground_guard v3,
   while fixing three playability regressions found on phone testing:
   - mobile hold-to-run was overwritten every frame by keyboard state;
   - base walk/run speeds were too slow for the world scale;
   - GTA-01 harbour objective sat inside the carved bay water and became
     unreachable once unsafe scene-mesh grounding was disabled.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN) return;

  // 1) Mobile run: input.js' keyboard fold clears state.run whenever Shift is
  // not held. Preserve the touch hold state after that fold has run.
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

  // 2) Locomotion scale: keep acceleration/animation/collision behavior, only
  // raise the two target speeds. Desktop Shift and mobile hold use same values.
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

  // 3) GTA-01 objective: (16,26) is inside the analytic bay polygon. With
  // stable terrain-only grounding, the shore blocker correctly prevents the
  // player entering that water. Move the objective onto the adjacent quay at
  // (12,20), beside the end of the town->quay ramp, so it is physically
  // reachable without weakening coastline collision rules.
  if (TOWN.Missions && !TOWN.Missions.__harbourReachFix) {
    const Missions = TOWN.Missions;
    const originalRegister = Missions.register;
    if (typeof originalRegister === 'function') {
      Missions.register = function (definition) {
        if (definition && definition.id === 'gta01-harbour-run') {
          const patched = Object.assign({}, definition);
          patched.objectives = definition.objectives.map(function (objective) {
            if (!objective || objective.id !== 'reach-harbour') return objective;
            return Object.assign({}, objective, {
              position: { x: 12, z: 20 },
              radius: 4.5,
            });
          });
          return originalRegister.call(Missions, patched);
        }
        return originalRegister.call(Missions, definition);
      };
      Missions.__harbourReachFix = true;
    }
  }

  console.log('[TOWN] playability fix v1 ready');
})(window);
