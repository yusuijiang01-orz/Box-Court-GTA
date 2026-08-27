/* =============================================================
   js/game/gta08c_controls.js — GTA-08C mobile action / driving controls

   Scope:
   - re-layout on-foot action buttons so they never overlap;
   - icon-only weapon switch (shows the weapon you will switch to);
   - on touch devices, replace the driving joystick with left/right steering;
   - separate accelerator and brake behavior, plus D/R gear selection;
   - preserve desktop WASD driving and all existing vehicle physics/collision.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game || !TOWN.Vehicles || !TOWN.Input) return;

  const Game = TOWN.Game;
  const V = TOWN.Vehicles;
  const GTA07 = TOWN.GTA07;

  const C = TOWN.GTA08C = {
    version: 'GTA-08C.1',
    initialized: false,
    touchCapable: !!((global.navigator && global.navigator.maxTouchPoints > 0) ||
      (global.matchMedia && global.matchMedia('(pointer:coarse)').matches)),
    gear: 'D',
    wasDriving: false,
    drive: { left: false, right: false, gas: false, brake: false, handbrake: false },
    els: {},
  };

  const ICONS = {
    fist: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 15V9.2a2.1 2.1 0 0 1 4.2 0v4.5-7a2.1 2.1 0 0 1 4.2 0v7-5.6a2.1 2.1 0 0 1 4.2 0v6.1-3a2.1 2.1 0 0 1 4.2 0v7.1c0 5.7-3.5 9.1-9.2 9.1h-.8c-3.2 0-5.4-1.1-7.4-3.5l-3.3-4a2.2 2.2 0 0 1 3.2-3l2.6 2"/></svg>',
    pistol: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14l5-3.5 5 2-3.4 5H19l-1.8 4.4H13L12 16H4z"/><path d="m16.8 19.9-1.4 8H10l-1.2-12"/></svg>',
  };

  function isDriving() {
    return !!(V.STATES && V.state === V.STATES.DRIVING && V.current && V.current.car);
  }

  function installStyle() {
    if (document.getElementById('gta08c-style')) return;
    const s = document.createElement('style');
    s.id = 'gta08c-style';
    s.textContent = [
      'body.game-play:not(.gta-vehicle-mode) .actionpad{right:max(12px,env(safe-area-inset-right))!important;bottom:max(12px,env(safe-area-inset-bottom))!important;width:150px!important;height:150px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act{width:56px!important;height:56px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="attack"]{right:88px!important;bottom:82px!important;width:60px!important;height:60px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="jump"]{right:10px!important;bottom:84px!important;width:54px!important;height:54px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="run"]{right:88px!important;bottom:8px!important;width:50px!important;height:50px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="interact"]{right:4px!important;bottom:2px!important;width:58px!important;height:58px!important}',
      'body.game-play:not(.gta-vehicle-mode) #gta07-switch{right:calc(max(12px,env(safe-area-inset-right)) + 158px)!important;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 78px)!important;width:44px!important;height:44px!important;padding:0!important;display:grid!important;place-items:center!important;font-size:0!important;background:rgba(7,10,13,.38)!important;border:1px solid rgba(255,255,255,.42)!important;color:#fff!important}',
      '#gta07-switch .gta08c-switch-icon{width:27px;height:27px;display:block;pointer-events:none}',
      '#gta07-switch .gta08c-switch-icon svg{width:100%;height:100%;display:block}',
      'body.gta-vehicle-mode .joy,body.gta-vehicle-mode .actionpad,body.gta-vehicle-mode #gta07-switch,body.gta-vehicle-mode #gta03-aim,body.gta-vehicle-mode #gta03-reload{display:none!important}',
      '#gta08c-drive{position:fixed;inset:0;z-index:185;display:none;pointer-events:none;user-select:none;-webkit-user-select:none}',
      '#gta08c-steer{position:absolute;left:max(16px,env(safe-area-inset-left));bottom:max(18px,env(safe-area-inset-bottom));display:flex;gap:12px;pointer-events:auto}',
      '#gta08c-pedals{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:grid;grid-template-columns:66px 66px;grid-template-rows:48px 76px;gap:9px;pointer-events:auto}',
      '.gta08c-drive-btn{appearance:none;-webkit-appearance:none;border:1px solid rgba(255,255,255,.42);background:rgba(7,10,13,.38);color:#fff;box-shadow:0 2px 7px rgba(0,0,0,.35);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);touch-action:none;-webkit-tap-highlight-color:transparent;font-family:system-ui,-apple-system,sans-serif;font-weight:900}',
      '.gta08c-drive-btn.active{transform:scale(.94);background:rgba(255,255,255,.20);border-color:rgba(255,255,255,.82)}',
      '#gta08c-left,#gta08c-right{width:70px;height:70px;border-radius:50%;font-size:34px;line-height:1}',
      '#gta08c-handbrake,#gta08c-exit{height:48px;border-radius:15px;font-size:11px;letter-spacing:.06em}',
      '#gta08c-brake,#gta08c-gas{height:76px;border-radius:17px;font-size:13px;letter-spacing:.08em}',
      '#gta08c-brake{background:rgba(130,34,30,.43)}',
      '#gta08c-gas{background:rgba(34,112,48,.43)}',
      '#gta08c-gear{position:absolute;right:calc(max(16px,env(safe-area-inset-right)) + 150px);bottom:max(22px,env(safe-area-inset-bottom));width:48px;height:48px;border-radius:50%;pointer-events:auto;font:900 15px/1 ui-monospace,monospace}',
      '#gta08c-gear small{display:block;font:700 7px/1 system-ui,sans-serif;opacity:.72;margin-top:2px}',
      '#gta08c-drive-note{position:absolute;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);padding:5px 8px;border-radius:7px;background:rgba(0,0,0,.42);color:rgba(255,255,255,.76);font:700 9px/1 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none}',
      '@media(max-height:430px) and (orientation:landscape){',
      'body.game-play:not(.gta-vehicle-mode) .actionpad{width:136px!important;height:136px!important;right:max(8px,env(safe-area-inset-right))!important;bottom:max(8px,env(safe-area-inset-bottom))!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="attack"]{right:80px!important;bottom:74px!important;width:54px!important;height:54px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="jump"]{right:8px!important;bottom:76px!important;width:50px!important;height:50px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="run"]{right:80px!important;bottom:6px!important;width:46px!important;height:46px!important}',
      'body.game-play:not(.gta-vehicle-mode) .actionpad .hud-btn.act[data-name="interact"]{right:2px!important;bottom:0!important;width:52px!important;height:52px!important}',
      'body.game-play:not(.gta-vehicle-mode) #gta07-switch{right:calc(max(8px,env(safe-area-inset-right)) + 143px)!important;bottom:calc(max(8px,env(safe-area-inset-bottom)) + 70px)!important;width:40px!important;height:40px!important}',
      '#gta08c-left,#gta08c-right{width:62px;height:62px;font-size:30px}',
      '#gta08c-pedals{grid-template-columns:60px 60px;grid-template-rows:42px 68px;gap:7px}',
      '#gta08c-handbrake,#gta08c-exit{height:42px;font-size:10px}',
      '#gta08c-brake,#gta08c-gas{height:68px;font-size:12px}',
      '#gta08c-gear{right:calc(max(12px,env(safe-area-inset-right)) + 134px);width:42px;height:42px;font-size:13px}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function makeButton(id, html, title) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'gta08c-drive-btn';
    b.innerHTML = html;
    b.title = title || '';
    return b;
  }

  function bindHold(el, field) {
    if (!el) return;
    let pointer = -1;
    const release = function (e) {
      if (pointer !== -1 && e && e.pointerId !== undefined && e.pointerId !== pointer) return;
      pointer = -1;
      C.drive[field] = false;
      el.classList.remove('active');
    };
    el.addEventListener('pointerdown', function (e) {
      if (!isDriving()) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      C.drive[field] = true;
      el.classList.add('active');
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
  }

  function installDOM() {
    if (C.els.root) return;
    const root = document.createElement('div');
    root.id = 'gta08c-drive';
    const steer = document.createElement('div');
    steer.id = 'gta08c-steer';
    const left = makeButton('gta08c-left', '←', '向左转');
    const right = makeButton('gta08c-right', '→', '向右转');
    steer.appendChild(left); steer.appendChild(right);
    const pedals = document.createElement('div');
    pedals.id = 'gta08c-pedals';
    const hand = makeButton('gta08c-handbrake', '手刹', '手刹');
    const exit = makeButton('gta08c-exit', '下车', '下车');
    const brake = makeButton('gta08c-brake', '刹车', '制动');
    const gas = makeButton('gta08c-gas', '油门', '加速');
    pedals.appendChild(hand); pedals.appendChild(exit); pedals.appendChild(brake); pedals.appendChild(gas);
    const gear = makeButton('gta08c-gear', 'D<small>挡位</small>', 'D / R 挡');
    const note = document.createElement('div');
    note.id = 'gta08c-drive-note';
    note.textContent = 'D 挡';
    root.appendChild(steer); root.appendChild(pedals); root.appendChild(gear); root.appendChild(note);
    document.body.appendChild(root);

    C.els.root = root; C.els.left = left; C.els.right = right; C.els.handbrake = hand;
    C.els.exit = exit; C.els.brake = brake; C.els.gas = gas; C.els.gear = gear; C.els.note = note;
    bindHold(left, 'left'); bindHold(right, 'right'); bindHold(hand, 'handbrake'); bindHold(brake, 'brake'); bindHold(gas, 'gas');

    exit.addEventListener('pointerdown', function (e) {
      if (!isDriving() || !Game.input || !Game.input.state) return;
      e.preventDefault(); e.stopPropagation();
      Game.input.state.interactPressed = true;
      exit.classList.add('active');
    });
    const exitUp = function () { exit.classList.remove('active'); };
    exit.addEventListener('pointerup', exitUp); exit.addEventListener('pointercancel', exitUp);

    gear.addEventListener('pointerdown', function (e) {
      if (!isDriving() || !V.current) return;
      e.preventDefault(); e.stopPropagation();
      if (Math.abs(V.current.speed || 0) > 0.9) {
        if (C.els.note) C.els.note.textContent = '先停车再换挡';
        return;
      }
      C.gear = C.gear === 'D' ? 'R' : 'D';
      syncGear();
    });
  }

  function syncGear() {
    if (C.els.gear) C.els.gear.innerHTML = C.gear + '<small>挡位</small>';
    if (C.els.note) C.els.note.textContent = C.gear === 'D' ? 'D 挡 · 前进' : 'R 挡 · 倒车';
  }

  function clearDriveState() {
    C.drive.left = C.drive.right = false;
    C.drive.gas = C.drive.brake = C.drive.handbrake = false;
    if (V.touch) V.touch.throttle = V.touch.brake = V.touch.handbrake = false;
    ['left','right','gas','brake','handbrake'].forEach(function (k) {
      if (C.els[k]) C.els[k].classList.remove('active');
    });
  }

  function applyPedals() {
    if (!isDriving() || !V.touch || !V.current) return;
    const speed = Number(V.current.speed) || 0;
    let throttle = false, brake = false;

    if (C.drive.gas && !C.drive.brake) {
      if (C.gear === 'D') throttle = true;
      else brake = true;
    }

    // Brake is always a brake; it cannot change the requested travel direction.
    if (C.drive.brake) {
      throttle = false; brake = false;
      if (speed > 0.22) brake = true;
      else if (speed < -0.22) throttle = true;
    }

    V.touch.throttle = throttle;
    V.touch.brake = brake;
    V.touch.handbrake = !!C.drive.handbrake;
  }

  function installInputOverride() {
    if (TOWN.Input.prototype.update.__gta08cWrapped) return;
    const base = TOWN.Input.prototype.update;
    const wrapped = function (dt) {
      base.call(this, dt);
      if (C.touchCapable && isDriving()) {
        this.state.move.x = (C.drive.right ? 1 : 0) - (C.drive.left ? 1 : 0);
        this.state.move.y = 0;
      }
    };
    wrapped.__gta08cWrapped = true;
    TOWN.Input.prototype.update = wrapped;
  }

  function syncWeaponSwitch() {
    const sw = document.getElementById('gta07-switch');
    if (!sw || isDriving()) return;
    const pistol = !!(GTA07 && GTA07.SLOT && GTA07.slot === GTA07.SLOT.PISTOL);
    const icon = pistol ? ICONS.fist : ICONS.pistol;
    const target = pistol ? '切换到徒手' : '切换到手枪';
    if (sw.dataset.gta08cTarget !== target) {
      sw.dataset.gta08cTarget = target;
      sw.title = target;
      sw.innerHTML = '<span class="gta08c-switch-icon">' + icon + '</span>';
    }
  }

  function syncMode() {
    const driving = isDriving();
    if (driving && !C.wasDriving) {
      C.gear = 'D';
      clearDriveState();
      syncGear();
      if (Game.input && Game.input._joy) {
        Game.input._joy.active = false;
        Game.input._joy.id = -1;
        Game.input.state.move.x = 0;
        Game.input.state.move.y = 0;
      }
    } else if (!driving && C.wasDriving) {
      clearDriveState();
    }
    C.wasDriving = driving;
    if (C.els.root) C.els.root.style.display = driving && C.touchCapable && Game.mode === 'play' && !Game.settingsOpen ? 'block' : 'none';
  }

  C.init = function () {
    if (C.initialized) return;
    C.initialized = true;
    installStyle(); installDOM(); installInputOverride(); syncGear();
    console.log('[GTA-08C] mobile action / driving controls ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    C.init();
    return out;
  };

  const baseUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!C.initialized) C.init();
    syncMode();
    if (C.touchCapable && isDriving()) applyPedals();
    const out = baseUpdate.call(Game, dt, elapsed);
    syncMode();
    syncWeaponSwitch();
    return out;
  };

  global.addEventListener('blur', clearDriveState);
  if (global.document) global.document.addEventListener('visibilitychange', function () {
    if (global.document.visibilityState !== 'visible') clearDriveState();
  });
})(window);
