/* =============================================================
   js/game/gta08b_hud.js — GTA-08B GTA-style HUD layout + mobile icons

   Presentation-only layer:
   - minimap fixed at upper-left;
   - health / cash / weapon / ammo / wanted stars unified at upper-right;
   - mobile run / jump / melee icons replaced with clearer silhouettes;
   - dialogue icon is left unchanged.
   No gameplay logic is changed.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const GTA07 = TOWN.GTA07;
  const Weapons = TOWN.Weapons;
  const EnemyAI = TOWN.EnemyAI;
  const Wanted = TOWN.Wanted;

  const H = TOWN.GTA08B = {
    version: 'GTA-08B.1',
    initialized: false,
    els: {},
    lastSlot: -1,
  };

  const ICONS = {
    fist: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 10.5V6.9a1.55 1.55 0 0 1 3.1 0v2.8-4a1.55 1.55 0 0 1 3.1 0v4-3.1a1.55 1.55 0 0 1 3.1 0v3.7-2a1.55 1.55 0 0 1 3.1 0v5.3c0 4.4-2.7 7-7.2 7h-.7c-2.4 0-4.1-.8-5.6-2.6L3.7 15a1.65 1.65 0 0 1 2.4-2.25l2 1.55"/></svg>',
    run: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15.7" cy="4.2" r="2"/><path d="m13.9 7-3.2 3.6-4.2.8"/><path d="m11.1 10.2 4 2.2 1.8 4.1"/><path d="m13.1 8.2 4.1 1 2.4-2.1"/><path d="m11.4 13.1-3.1 4.8-4.1 1.5"/><path d="m15.7 13.8 3.1 3.6 1.3 3.2"/></svg>',
    jump: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="m12 7.5-2 4 2.3 2.6"/><path d="m10.3 9.4-3.6-2.1"/><path d="m13.7 9.3 3.8-2.5"/><path d="m12.3 14.1-4 3.1"/><path d="m12.3 14.1 4.8 2.3"/><path d="M4 20c2.1-1.3 4.2-1.9 6.3-1.7 2.1.2 3.7 1.4 5.6 1.4 1.5 0 2.8-.5 4.1-1.4"/></svg>',
    pistol: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14l5-3.5 5 2-3.4 5H19l-1.8 4.4H13L12 16H4z"/><path d="m16.8 19.9-1.4 8H10l-1.2-12"/></svg>',
  };

  function installStyle() {
    if (document.getElementById('gta08b-style')) return;
    const s = document.createElement('style');
    s.id = 'gta08b-style';
    s.textContent = [
      'body.game-play #gta07-status,body.game-play #gta03-ammo,body.game-play #gta04-player-hp,body.game-play #gta06-wanted{display:none!important}',
      'body.game-play #timechip,body.game-play #hud-orbit{display:none!important}',

      '#gta07-radar-wrap{left:max(10px,env(safe-area-inset-left))!important;top:max(10px,env(safe-area-inset-top))!important;bottom:auto!important;width:104px!important;height:104px!important;border:2px solid rgba(255,255,255,.72)!important;box-shadow:0 2px 8px rgba(0,0,0,.55)!important;background:rgba(4,7,10,.70)!important}',
      'body.game-play #mission-hud{left:max(10px,env(safe-area-inset-left))!important;top:124px!important;width:min(230px,42vw)!important}',

      '#gta08b-status{position:fixed;z-index:176;right:max(10px,env(safe-area-inset-right));top:max(10px,env(safe-area-inset-top));width:174px;color:#fff;text-align:right;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;text-shadow:0 2px 3px rgba(0,0,0,.95);display:none}',
      '#gta08b-cash{font:900 18px/1 ui-monospace,monospace;color:#77d66b;letter-spacing:.02em}',
      '#gta08b-main{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:5px}',
      '#gta08b-weapon-icon{width:48px;height:42px;display:grid;place-items:center;color:#fff}',
      '#gta08b-weapon-icon svg{width:45px;height:38px;filter:drop-shadow(0 2px 1px rgba(0,0,0,.85))}',
      '#gta08b-ammo{font:900 14px/1 ui-monospace,monospace;white-space:nowrap}',
      '#gta08b-weapon-name{margin-top:3px;font:800 9px/1 system-ui,sans-serif;letter-spacing:.08em;color:rgba(255,255,255,.78)}',
      '#gta08b-health-head{display:flex;justify-content:space-between;margin-top:5px;font:800 9px/1 system-ui,sans-serif;color:rgba(255,255,255,.86)}',
      '#gta08b-health-bar{height:7px;margin-top:3px;border:1px solid rgba(255,255,255,.82);background:rgba(0,0,0,.62);box-shadow:0 1px 2px rgba(0,0,0,.8);overflow:hidden}',
      '#gta08b-health-bar i{display:block;height:100%;width:100%;background:#d94b45;transform-origin:left center}',
      '#gta08b-stars{margin-top:5px;font:900 17px/1 ui-monospace,monospace;letter-spacing:1px;white-space:nowrap}',
      '#gta08b-stars span{color:rgba(255,255,255,.22)}#gta08b-stars span.on{color:#ffd04a;text-shadow:0 0 5px rgba(255,190,40,.5)}',
      '#gta08b-search{margin-top:2px;font:800 8px/1.1 system-ui,sans-serif;color:#a9dcff;min-height:9px}',

      'body.game-play #hud-gear{position:fixed!important;z-index:178!important;top:max(10px,env(safe-area-inset-top))!important;right:calc(max(10px,env(safe-area-inset-right)) + 184px)!important;width:32px!important;height:32px!important;background:rgba(8,11,14,.42)!important;border-color:rgba(255,255,255,.32)!important;color:#fff!important;box-shadow:0 2px 6px rgba(0,0,0,.35)!important}',

      'body.game-play .actionpad .hud-btn.act .ic{width:30px!important;height:30px!important}',
      'body.game-play .actionpad .hud-btn.act[data-name="run"] .ic{width:27px!important;height:27px!important}',
      'body.game-play .actionpad .hud-btn.act{background:rgba(7,10,13,.30)!important;border:1px solid rgba(255,255,255,.42)!important;color:#fff!important;box-shadow:0 2px 6px rgba(0,0,0,.35)!important}',
      'body.game-play .actionpad .hud-btn.act[data-name="interact"]{background:rgba(184,98,60,.68)!important}',

      '@media(pointer:coarse) and (orientation:landscape){',
      '#gta07-radar-wrap{width:96px!important;height:96px!important}',
      'body.game-play #mission-hud{top:114px!important;width:min(210px,40vw)!important}',
      '#gta08b-status{width:158px}',
      '#gta08b-cash{font-size:16px}',
      '#gta08b-weapon-icon{width:43px;height:38px}',
      '#gta08b-weapon-icon svg{width:40px;height:34px}',
      '#gta08b-ammo{font-size:13px}',
      '#gta08b-stars{font-size:15px}',
      'body.game-play #hud-gear{right:calc(max(10px,env(safe-area-inset-right)) + 168px)!important}',
      '}',

      '@media(max-height:420px) and (orientation:landscape){',
      '#gta07-radar-wrap{width:90px!important;height:90px!important}',
      'body.game-play #mission-hud{top:106px!important}',
      '#gta08b-status{top:7px;width:150px}',
      '#gta08b-main{margin-top:3px}',
      '#gta08b-stars{margin-top:3px}',
      'body.game-play #hud-gear{top:7px!important;right:calc(max(8px,env(safe-area-inset-right)) + 158px)!important}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (H.els.root) return;
    const root = document.createElement('div');
    root.id = 'gta08b-status';
    root.innerHTML = [
      '<div id="gta08b-cash">$0</div>',
      '<div id="gta08b-main">',
        '<div><div id="gta08b-ammo">--</div><div id="gta08b-weapon-name">徒手</div></div>',
        '<div id="gta08b-weapon-icon"></div>',
      '</div>',
      '<div id="gta08b-health-head"><span>生命</span><b>100</b></div>',
      '<div id="gta08b-health-bar"><i></i></div>',
      '<div id="gta08b-stars"></div>',
      '<div id="gta08b-search"></div>'
    ].join('');
    document.body.appendChild(root);
    H.els.root = root;
    H.els.cash = root.querySelector('#gta08b-cash');
    H.els.icon = root.querySelector('#gta08b-weapon-icon');
    H.els.ammo = root.querySelector('#gta08b-ammo');
    H.els.weapon = root.querySelector('#gta08b-weapon-name');
    H.els.health = root.querySelector('#gta08b-health-head b');
    H.els.healthFill = root.querySelector('#gta08b-health-bar i');
    H.els.stars = root.querySelector('#gta08b-stars');
    H.els.search = root.querySelector('#gta08b-search');
  }

  function setActionIcons() {
    const run = document.querySelector('.actionpad [data-name="run"]');
    const jump = document.querySelector('.actionpad [data-name="jump"]');
    const attack = document.querySelector('.actionpad [data-name="attack"]');
    if (run && run.dataset.gta08b !== '1') {
      run.innerHTML = ICONS.run;
      run.title = '奔跑';
      run.dataset.gta08b = '1';
    }
    if (jump && jump.dataset.gta08b !== '1') {
      jump.innerHTML = ICONS.jump;
      jump.title = '跳跃';
      jump.dataset.gta08b = '1';
    }
    if (GTA07 && GTA07.attackOriginal) {
      GTA07.attackOriginal.html = ICONS.fist;
      GTA07.attackOriginal.title = '攻击';
    }
    const unarmed = !GTA07 || !GTA07.SLOT || GTA07.slot === GTA07.SLOT.UNARMED;
    if (attack && unarmed && attack.dataset.gta03 !== '1') {
      attack.innerHTML = ICONS.fist;
      attack.title = '攻击';
      attack.dataset.gta08b = '1';
    }
  }

  function syncWeaponIcon(pistol) {
    const slot = pistol ? 1 : 0;
    if (H.lastSlot === slot) return;
    H.lastSlot = slot;
    if (H.els.icon) H.els.icon.innerHTML = pistol ? ICONS.pistol : ICONS.fist;
  }

  function syncStatus() {
    const active = Game.mode === 'play' && !Game.settingsOpen && !!Game.player;
    if (H.els.root) H.els.root.style.display = active ? 'block' : 'none';
    if (!active) return;

    const money = Math.max(0, Math.floor(TOWN.Economy && isFinite(TOWN.Economy.money) ? TOWN.Economy.money : 0));
    if (H.els.cash) H.els.cash.textContent = '$' + money.toLocaleString('en-US');

    const pistol = !!(GTA07 && GTA07.SLOT && GTA07.slot === GTA07.SLOT.PISTOL);
    syncWeaponIcon(pistol);
    if (H.els.weapon) H.els.weapon.textContent = pistol ? '手枪' : '徒手';
    if (H.els.ammo) H.els.ammo.textContent = pistol && Weapons ? (Math.max(0, Weapons.ammo | 0) + ' / ' + Math.max(0, Weapons.reserve | 0)) : '--';

    const maxHp = EnemyAI && isFinite(EnemyAI.playerMaxHealth) ? Math.max(1, EnemyAI.playerMaxHealth) : 100;
    const hp = EnemyAI && isFinite(EnemyAI.playerHealth) ? Math.max(0, Math.min(maxHp, EnemyAI.playerHealth)) : maxHp;
    if (H.els.health) H.els.health.textContent = Math.ceil(hp);
    if (H.els.healthFill) H.els.healthFill.style.transform = 'scaleX(' + (hp / maxHp) + ')';

    const stars = Wanted && isFinite(Wanted.stars) ? Math.max(0, Math.min(5, Wanted.stars | 0)) : 0;
    if (H.els.stars) {
      let html = '';
      for (let i = 0; i < 5; i++) html += '<span class="' + (i < stars ? 'on' : '') + '">★</span>';
      H.els.stars.innerHTML = html;
    }
    if (H.els.search) {
      if (!stars) H.els.search.textContent = '';
      else if (Wanted.seen || Wanted.crimePulse > 0.01) H.els.search.textContent = '追捕中 · ' + stars + ' 星';
      else H.els.search.textContent = '脱离搜捕 ' + Math.max(0, Wanted.escapeTimer || 0).toFixed(1) + 's';
    }

    setActionIcons();
  }

  H.init = function () {
    if (H.initialized) return;
    H.initialized = true;
    installStyle();
    installDOM();
    setActionIcons();
    global.requestAnimationFrame(function () { global.dispatchEvent(new Event('resize')); });
    console.log('[GTA-08B] GTA-style HUD layout ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    H.init();
    return out;
  };

  const baseUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!H.initialized) H.init();
    const out = baseUpdate.call(Game, dt, elapsed);
    syncStatus();
    return out;
  };
})(window);
