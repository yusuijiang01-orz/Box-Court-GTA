/* =============================================================
   js/game/ground_guard.js — grounded support validator

   Post-validates Player.update() without replacing the existing movement,
   stair, collision, jump or camera systems.  The legacy ground sampler can
   occasionally accept an upward-facing roof / balcony hit slightly above
   the feet and then repeat that small rise over many frames.  That produces
   the visible "slow floating" bug.

   This guard only corrects DOWNWARD.  After the normal player update it asks
   a stricter question: "is there a real walkable support surface at or just
   below the CURRENT foot height?"  Surfaces above the feet are never allowed
   to pull the player upward here.  Real stairs / slopes / decks remain valid
   because, after a legitimate step-up, their surface is already at the
   current foot height.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Player || !TOWN.Island) return;

  const Player = TOWN.Player;
  if (Player.__groundGuardInstalled) return;

  const originalUpdate = Player.update;
  if (typeof originalUpdate !== 'function') return;

  const ray = new T.Raycaster();
  const origin = new T.Vector3();
  const down = new T.Vector3(0, -1, 0);
  const normalMatrix = new T.Matrix3();
  const worldNormal = new T.Vector3();

  // The support query starts only 8 cm above the current feet.  A roof or
  // balcony that is still above the character therefore cannot become the
  // new support merely because a long ray happened to see it.
  const SUPPORT_HEADROOM = 0.08;
  const SUPPORT_RAY_LEN = 1.35;
  const ABOVE_FOOT_TOL = 0.045;
  const GROUNDED_GAP_TOL = 0.055;
  const ZERO_VY = 0.025;

  function strictSupportY(st) {
    const footY = st.o.position.y;
    const x = st.o.position.x;
    const z = st.o.position.z;
    let bestY = -Infinity;
    let found = false;

    const meshes = Player.groundMeshes;
    if (meshes && meshes.length) {
      origin.set(x, footY + SUPPORT_HEADROOM, z);
      ray.set(origin, down, 0, SUPPORT_RAY_LEN);
      const hits = ray.intersectObjects(meshes, false);

      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (!h || !h.face || !isFinite(h.point.y)) continue;

        const py = h.point.y;
        // Critical rule: this validator NEVER accepts a surface meaningfully
        // above the current feet.  It may confirm the surface we already
        // stepped onto, but it cannot pump us toward a roof one frame at a
        // time.
        if (py > footY + ABOVE_FOOT_TOL) continue;

        normalMatrix.getNormalMatrix(h.object.matrixWorld);
        worldNormal.copy(h.face.normal).applyMatrix3(normalMatrix);
        if (worldNormal.y < 0.60) continue;

        // Ray hits are sorted nearest-first, but keep max-Y explicitly so the
        // rule stays correct even if the underlying list ordering changes.
        if (py > bestY) {
          bestY = py;
          found = true;
        }
      }
    }

    // Natural terrain is a valid fallback only on land.  On piers / decks
    // above water we deliberately do not invent a sea-level support.
    const isl = TOWN.Island.sample(x, z);
    if (isl && isl.land && isFinite(isl.y) && isl.y <= footY + ABOVE_FOOT_TOL) {
      if (!found || isl.y > bestY) {
        bestY = isl.y;
        found = true;
      }
    }

    return found ? bestY : null;
  }

  Player.update = function (st, input, camera, dt, et) {
    const out = originalUpdate.call(Player, st, input, camera, dt, et);
    if (!st || !st.o || !st.o.position) return out;

    // Never interfere with a real jump / fall.  The legacy floating failure
    // normally reports either onGround=true or onGround=false with vy≈0 after
    // its upward clamp, so both cases are covered without touching normal
    // airborne motion.
    const canValidate = st.onGround || Math.abs(st.vy || 0) <= ZERO_VY;
    if (!canValidate) return out;

    const supportY = strictSupportY(st);
    if (supportY === null) return out;

    const gap = st.o.position.y - supportY;
    if (gap > GROUNDED_GAP_TOL) {
      st.o.position.y = supportY;
      st.vy = 0;
      st.onGround = true;

      // Reset the old anti-fly streak after a confirmed correction so it does
      // not immediately trip its fallback based on stale frames.
      if (st._gg) {
        st._gg.riseStreak = 0;
        st._gg.sawRiseThisFrame = false;
        st._gg.floatSince = 0;
        st._gg.lastGoodY = supportY;
        st._gg.lastGoodT = Date.now ? Date.now() : 0;
      }
    }

    return out;
  };

  Player.__groundGuardInstalled = true;
  console.log('[TOWN] grounded support guard ready');
})(window);
