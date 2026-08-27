/* =============================================================
   js/game/ground_guard.js — stability grounding mode

   The legacy player ground system raycasts against a very broad scene-mesh
   list many times per frame. In play mode this can both:
   - accept false elevated surfaces and pump the player upward;
   - become extremely expensive on mobile, while diorama mode remains 60 FPS.

   Stability mode disables that broad mesh list before every Player.update(),
   forcing the existing player code to fall back to TOWN.Island.sample().
   This intentionally prioritizes stable terrain grounding and frame rate.
   Precise stairs / decks / piers can be reintroduced later with a small,
   explicitly tagged walkable-surface set instead of the whole scene.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Player) return;

  const Player = TOWN.Player;
  if (Player.__groundGuardInstalled) return;

  const originalUpdate = Player.update;
  if (typeof originalUpdate !== 'function') return;

  let cleared = false;

  function disableBroadMeshGrounding() {
    if (cleared && Player.groundMeshes && Player.groundMeshes.length === 0) return;

    // Empty list = sampleGroundY() takes its cheap Island.sample() fallback
    // and performs no Three.js scene raycasts.
    Player.groundMeshes = [];

    // shell.js caches the broad list on TOWN.Game. Clear that reference too
    // so it cannot be restored later when switching camera/game modes.
    if (TOWN.Game) TOWN.Game.groundMeshes = [];

    cleared = true;
  }

  Player.update = function (st, input, camera, dt, et) {
    disableBroadMeshGrounding();
    return originalUpdate.call(Player, st, input, camera, dt, et);
  };

  Player.__groundGuardInstalled = true;
  console.log('[TOWN] stability grounding v3: scene mesh raycasts disabled');
})(window);
