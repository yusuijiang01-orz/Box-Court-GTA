/* =============================================================
   js/game/gta08d_attack_stick.js — GTA-08D twin-stick combat controls

   Mobile combat changes:
   - swap attack / interact positions;
   - replace the old attack tap button with a directional attack stick;
   - left movement joystick and right attack stick can be used simultaneously;
   - pistol: drag to aim independently of movement, hold outside deadzone to fire;
   - unarmed: drag chooses strike direction and triggers one melee attack;
   - quick tap attacks in the current facing direction.
   ============================================================= */
(function (global) {
  'use strict';
  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const V = TOWN.Vehicles;
  const W = TOWN.Weapons;
  const GTA07 = TOWN.GTA07;
  const THREE = global.THREE;

  const D = TOWN.GTA08D = {
    version: 'GTA-08D.1',
    initialized: false,
    touchCapable: !!((global.navigator && global.navigator.maxTouchPoints > 0) ||
      (global.matchMedia && global.matchMedia('(pointer:coarse)').matches)),
    attack: {
      active: false,
      aiming: false,
      pointer: -1,
      yaw: null,
      magnitude: 0,
      centerX: 0,
      centerY: 0,
      maxR: 26,
      meleeTriggered: false,
      tapQueued: false,
      tapYaw: 0,
    },
    els: {},
  };

  const ICONS = {
    fist: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 15V9.2a2.1 2.1 0 0 1 4.2 0v4.5-7a2.1 2.1 0 0 1 4.2 0v7-5.6a2.1 2.1 0 0 1 4.2 0v6.1-3a2.1 2.1 0 0 1 4.2 0v7.1c0 5.7-3.5 9.1-9.2 9.1h-.8c-3.2 0-5.4-1.1-7.4-3.5l-3.3-4a2.2 2.2 0 0 1 3.2-3l2.6 2"/></svg>',
    pistol: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14l5-3.5 5 2-3.4 5H19l-1.8 4.4H13L12 16H4z"/><path d="m16.8 19.9-1.4 8H10l-1.2-12"/></svg>',
  };

  const tmpFwd = THREE ? new THREE.Vector3() : null;

  function isDriving() {
    return !!(V && V.STATES && V.state === V.STATES.DRIVING);
  }

  function isPistol() {
    return !!(GTA07 && GTA07.SLOT && GTA07.slot === GTA07.SLOT.PISTOL);
  }

  function canAttack() {
    return D.touchCapable && Game.mode === 'play' && !Game.settingsOpen &&
      Game.player && Game.player.o && !isDriving() && !Game._dlgNpc;
  }

  function installStyle() {
    if (document.getElementById('gta08d-style')) return;
    const s = document.createElement('style');
    s.id = 'gta08d-style';
    s.textContent = [
      'body.gta08d-touch.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="attack"]{display:none!important}',
      'body.gta08d-touch.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="interact"]{right:88px!important;bottom:82px!important;width:56px!important;height:56px!important}',
      'body.gta08d-touch.game-play:not(.gta-vehicle-mode) #gta03-aim{display:none!important}',
      '#gta08d-attack-stick{position:absolute;right:2px;bottom:0;width:72px;height:72px;border-radius:50%;pointer-events:auto;touch-action:none;-webkit-tap-highlight-color:transparent;background:rgba(7,10,13,.28);border:1px solid rgba(255,255,255,.48);box-shadow:0 2px 7px rgba(0,0,0,.38);display:none}',
      '#gta08d-attack-stick.active{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.82)}',
      '#gta08d-attack-stick:after{content:"";position:absolute;inset:9px;border-radius:50%;border:1px solid rgba(255,255,255,.13);pointer-events:none}',
      '#gta08d-attack-knob{position:absolute;left:50%;top:50%;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;display:grid;place-items:center;color:#fff;background:rgba(8,11,14,.72);border:1px solid rgba(255,255,255,.66);box-shadow:0 2px 5px rgba(0,0,0,.42);pointer-events:none;transform:translate(0,0)}',
      '#gta08d-attack-knob svg{width:24px;height:24px;display:block}',
      'body.gta08d-touch.game-play:not(.gta-vehicle-mode) #gta08d-attack-stick{display:block}',
      '@media(max-height:430px) and (orientation:landscape){',
      'body.gta08d-touch.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="interact"]{right:80px!important;bottom:74px!important;width:52px!important;height:52px!important}',
      '#gta08d-attack-stick{width:64px;height:64px;right:0;bottom:0}',
      '#gta08d-attack-knob{width:32px;height:32px;margin:-16px 0 0 -16px}',
      '#gta08d-attack-knob svg{width:21px;height:21px}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (D.els.stick) return;
    const pad = document.querySelector('.actionpad');
    if (!pad) return;
    const stick = document.createElement('div');
    stick.id = 'gta08d-attack-stick';
    stick.setAttribute('aria-label', '攻击摇杆');
    const knob = document.createElement('div');
    knob.id = 'gta08d-attack-knob';
    stick.appendChild(knob);
    pad.appendChild(stick);
    D.els.stick = stick;
    D.els.knob = knob;

    stick.addEventListener('pointerdown', onDown, { passive: false });
    stick.addEventListener('pointermove', onMove, { passive: false });
    stick.addEventListener('pointerup', onUp, { passive: false });
    stick.addEventListener('pointercancel', onUp, { passive: false });
    stick.addEventListener('lostpointercapture', onLostCapture, { passive: false });
    syncKnobIcon();
  }

  function currentFacingYaw() {
    return Game.player && Number.isFinite(Game.player.yaw) ? Game.player.yaw : 0;
  }

  function computeWorldYaw(nx, ny) {
    if (!THREE || !TOWN.Stage || !TOWN.Stage.camera) return currentFacingYaw();
    TOWN.Stage.camera.getWorldDirection(tmpFwd);
    tmpFwd.y = 0;
    const len = Math.hypot(tmpFwd.x, tmpFwd.z);
    if (len < 1e-5) tmpFwd.set(0, 0, -1);
    else { tmpFwd.x /= len; tmpFwd.z /= len; }
    const rightX = -tmpFwd.z;
    const rightZ = tmpFwd.x;
    const wx = tmpFwd.x * ny + rightX * nx;
    const wz = tmpFwd.z * ny + rightZ * nx;
    if (Math.hypot(wx, wz) < 1e-5) return currentFacingYaw();
    return Math.atan2(wx, wz);
  }

  function updateVector(e) {
    const a = D.attack;
    let dx = e.clientX - a.centerX;
    let dy = e.clientY - a.centerY;
    const raw = Math.hypot(dx, dy);
    const r = a.maxR;
    if (raw > r && raw > 0) { dx = dx / raw * r; dy = dy / raw * r; }
    const nx = dx / r;
    const ny = -dy / r;
    a.magnitude = Math.min(1, Math.hypot(nx, ny));
    if (a.magnitude > 0.16) a.yaw = computeWorldYaw(nx, ny);
    else a.yaw = currentFacingYaw();
    if (D.els.knob) D.els.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
  }

  function onDown(e) {
    if (!canAttack()) return;
    e.preventDefault();
    e.stopPropagation();
    const a = D.attack;
    a.pointer = e.pointerId;
    a.active = true;
    a.aiming = true;
    a.meleeTriggered = false;
    a.magnitude = 0;
    a.yaw = currentFacingYaw();
    const rect = D.els.stick.getBoundingClientRect();
    a.centerX = rect.left + rect.width * 0.5;
    a.centerY = rect.top + rect.height * 0.5;
    a.maxR = Math.max(20, rect.width * 0.36);
    if (D.els.stick.setPointerCapture) {
      try { D.els.stick.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (W && W.setAim) W.setAim(false);
    D.els.stick.classList.add('active');
    updateVector(e);
  }

  function onMove(e) {
    if (!D.attack.active || e.pointerId !== D.attack.pointer) return;
    e.preventDefault();
    e.stopPropagation();
    updateVector(e);
  }

  function queueTapAttack(yaw) {
    D.attack.tapQueued = true;
    D.attack.tapYaw = Number.isFinite(yaw) ? yaw : currentFacingYaw();
  }

  function releaseStick(e, cancelled) {
    const a = D.attack;
    if (!a.active) return;
    if (e && e.pointerId !== undefined && a.pointer !== -1 && e.pointerId !== a.pointer) return;
    if (!cancelled && a.magnitude <= 0.22) queueTapAttack(a.yaw);
    a.active = false;
    a.aiming = false;
    a.pointer = -1;
    a.magnitude = 0;
    a.meleeTriggered = false;
    if (D.els.stick) D.els.stick.classList.remove('active');
    if (D.els.knob) D.els.knob.style.transform = 'translate(0,0)';
  }

  function onUp(e) {
    e.preventDefault();
    e.stopPropagation();
    releaseStick(e, false);
  }

  function onLostCapture(e) {
    releaseStick(e, true);
  }

  function syncKnobIcon() {
    if (!D.els.knob) return;
    const key = isPistol() ? 'pistol' : 'fist';
    if (D.els.knob.dataset.icon === key) return;
    D.els.knob.dataset.icon = key;
    D.els.knob.innerHTML = ICONS[key];
  }

  function prepareAttackFrame() {
    const a = D.attack;
    if (!canAttack()) {
      if (a.active) releaseStick(null, true);
      a.aiming = false;
      a.tapQueued = false;
      return;
    }

    syncKnobIcon();
    if (a.active) {
      a.aiming = true;
      if (!Number.isFinite(a.yaw)) a.yaw = currentFacingYaw();
      if (a.magnitude > 0.22) {
        if (isPistol()) {
          if (W && W.fire) W.fire();
        } else if (!a.meleeTriggered && Game.input && Game.input.state) {
          Game.input.state.attackPressed = true;
          a.meleeTriggered = true;
        }
      }
    } else if (a.tapQueued) {
      a.aiming = true;
      a.yaw = a.tapYaw;
      if (isPistol()) {
        if (W && W.fire) W.fire();
      } else if (Game.input && Game.input.state) {
        Game.input.state.attackPressed = true;
      }
    } else {
      a.aiming = false;
    }
  }

  function finishAttackFrame() {
    if (D.attack.tapQueued) {
      D.attack.tapQueued = false;
      if (!D.attack.active) D.attack.aiming = false;
    }
  }

  D.init = function () {
    if (D.initialized) return;
    D.initialized = true;
    if (D.touchCapable) document.body.classList.add('gta08d-touch');
    installStyle();
    installDOM();
    console.log('[GTA-08D] twin-stick combat controls ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    D.init();
    return out;
  };

  const baseUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!D.initialized) D.init();
    prepareAttackFrame();
    const out = baseUpdate.call(Game, dt, elapsed);
    finishAttackFrame();
    return out;
  };

  global.addEventListener('blur', function () { releaseStick(null, true); });
  if (global.document) global.document.addEventListener('visibilitychange', function () {
    if (global.document.visibilityState !== 'visible') releaseStick(null, true);
  });
})(window);
