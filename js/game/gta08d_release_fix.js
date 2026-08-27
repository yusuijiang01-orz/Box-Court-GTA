/* =============================================================
   GTA-08D attack-stick release/recenter guard

   Some mobile browsers can lose the stick element's pointerup after capture
   transitions. Listen globally and force the public GTA08D attack state and
   knob visual back to neutral whenever the owning pointer ends, the page
   blurs, or the tab is backgrounded.
   ============================================================= */
(function (global) {
  'use strict';
  const TOWN = global.TOWN;
  if (!TOWN) return;

  function resetAttackStick(pointerId) {
    const D = TOWN.GTA08D;
    if (!D || !D.attack) return;
    const a = D.attack;
    if (pointerId !== undefined && pointerId !== null && a.pointer !== -1 && pointerId !== a.pointer) return;

    a.active = false;
    a.aiming = false;
    a.pointer = -1;
    a.magnitude = 0;
    a.meleeTriggered = false;
    a.yaw = null;

    const stick = document.getElementById('gta08d-attack-stick');
    const knob = document.getElementById('gta08d-attack-knob');
    if (stick) stick.classList.remove('active');
    if (knob) knob.style.transform = 'translate(0px,0px)';
  }

  global.addEventListener('pointerup', function (e) { resetAttackStick(e.pointerId); }, true);
  global.addEventListener('pointercancel', function (e) { resetAttackStick(e.pointerId); }, true);
  global.addEventListener('blur', function () { resetAttackStick(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') resetAttackStick();
  });

  TOWN.GTA08DReleaseGuard = { version: '1.0.0', reset: resetAttackStick };
  console.log('[GTA-08D] attack-stick release guard ready');
})(window);
