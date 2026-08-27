/* =============================================================
   js/game/gta08d_aim_bridge.js — GTA-08D pre-weapons aim bridge

   Loaded before weapons.js so directional touch aim can rotate the player
   after movement has been resolved but before GTA-03 computes shotDirection().
   ============================================================= */
(function (global) {
  'use strict';
  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  if (Game.update && Game.update.__gta08dAimBridge) return;

  const baseUpdate = Game.update;
  const wrapped = function (dt, elapsed) {
    const D = TOWN.GTA08D;
    const a = D && D.attack;
    const V = TOWN.Vehicles;
    const driving = !!(V && V.STATES && V.state === V.STATES.DRIVING);
    const st = Game.player;
    const active = !driving && Game.mode === 'play' && st && st.o &&
      a && a.aiming && Number.isFinite(a.yaw);

    // While the right attack stick is held, movement must translate the player
    // without stealing body facing back toward the movement vector. Temporarily
    // freeze Player.applyMove's turn interpolation, then restore the normal turn
    // rate immediately after the underlying on-foot update.
    let savedTurnRate = null;
    if (active) {
      st.yaw = a.yaw;
      st.moveYaw = a.yaw;
      st.o.rotation.y = a.yaw;
      if (Number.isFinite(st.turnRate)) { savedTurnRate = st.turnRate; st.turnRate = 0; }
    }

    const out = baseUpdate.call(Game, dt, elapsed);

    if (active && Game.player && Game.player.o) {
      if (savedTurnRate !== null) Game.player.turnRate = savedTurnRate;
      Game.player.yaw = a.yaw;
      Game.player.moveYaw = a.yaw;
      Game.player.o.rotation.y = a.yaw;
    }
    return out;
  };
  wrapped.__gta08dAimBridge = true;
  Game.update = wrapped;
})(window);
