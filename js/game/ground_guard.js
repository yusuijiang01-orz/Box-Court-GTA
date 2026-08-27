/* =============================================================
   js/game/ground_guard.js — grounded support validator

   Fixes the legacy ground sampler's "slow floating" failure in two layers:
   1) remove the player's own body meshes from Player.groundMeshes BEFORE the
      legacy movement update can raycast them;
   2) post-validate grounded support without ever accepting a surface above
      the current feet as a reason to move upward.

   This does not replace movement, stairs, collisions, jumping or camera code.
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

  const SUPPORT_HEADROOM = 0.08;
  const SUPPORT_RAY_LEN = 1.35;
  const ABOVE_FOOT_TOL = 0.045;
  const GROUNDED_GAP_TOL = 0.055;
  const ZERO_VY = 0.025;

  let sanitizedPlayerRoot = null;

  function belongsToPlayer(mesh, playerRoot) {
    let p = mesh;
    while (p) {
      if (p === playerRoot) return true;
      p = p.parent;
    }
    return false;
  }

  function sanitizeGroundMeshes(st) {
    if (!st || !st.o || sanitizedPlayerRoot === st.o) return;

    const meshes = Player.groundMeshes;
    if (!meshes || !meshes.length) {
      sanitizedPlayerRoot = st.o;
      return;
    }

    const clean = [];
    let removed = 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (mesh && belongsToPlayer(mesh, st.o)) {
        removed++;
        continue;
      }
      clean.push(mesh);
    }

    // Player.update reads this exact list for every grounding ray.
    Player.groundMeshes = clean;

    // shell.js stores the same cache on TOWN.Game. Keep both references in
    // sync so a later reuse cannot restore the contaminated list.
    if (TOWN.Game && TOWN.Game.groundMeshes === meshes) {
      TOWN.Game.groundMeshes = clean;
    }

    sanitizedPlayerRoot = st.o;
    if (removed > 0) {
      console.log('[TOWN] ground mesh fix: removed ' + removed + ' player-self meshes');
    }
  }

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
        // This validator never lets geometry above the current feet pull the
        // player upward. It may only confirm support already under the feet.
        if (py > footY + ABOVE_FOOT_TOL) continue;

        normalMatrix.getNormalMatrix(h.object.matrixWorld);
        worldNormal.copy(h.face.normal).applyMatrix3(normalMatrix);
        if (worldNormal.y < 0.60) continue;

        if (py > bestY) {
          bestY = py;
          found = true;
        }
      }
    }

    // Natural terrain is a fallback only on land. On a pier/deck above water,
    // do not invent sea-level support.
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
    // CRITICAL: sanitize before the legacy update. shell.js builds the
    // walkable list after adding the player to the scene, so descendant body
    // meshes can otherwise be collected as "ground". A downward ray then hits
    // the hero's own torso/head and pumps Y upward immediately after spawn.
    sanitizeGroundMeshes(st);

    const out = originalUpdate.call(Player, st, input, camera, dt, et);
    if (!st || !st.o || !st.o.position) return out;

    // Do not interfere with a real jump/fall.
    const canValidate = st.onGround || Math.abs(st.vy || 0) <= ZERO_VY;
    if (!canValidate) return out;

    const supportY = strictSupportY(st);
    if (supportY === null) return out;

    const gap = st.o.position.y - supportY;
    if (gap > GROUNDED_GAP_TOL) {
      st.o.position.y = supportY;
      st.vy = 0;
      st.onGround = true;

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
  console.log('[TOWN] grounded support guard v2 ready');
})(window);
