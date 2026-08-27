/* =============================================================
   js/game/gta07_systems.js — GTA-07 minimap / economy / weapon switching

   Scope:
   - rotating local minimap (roads, mission, vehicles, enemies, police);
   - cash HUD backed by TOWN.Economy.money;
   - two-slot weapon selector: unarmed <-> pistol;
   - desktop: 1/2 + mouse wheel; mobile: dedicated switch button.

   No shop, weapon pickup, extra firearms or persistent economy save.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const U = TOWN.U;
  const Roads = TOWN.Roads || {};
  const Dynamics = TOWN.Dynamics || {};
  const Missions = TOWN.Missions;
  const Vehicles = TOWN.Vehicles;
  const Weapons = TOWN.Weapons;
  const EnemyAI = TOWN.EnemyAI;
  const Wanted = TOWN.Wanted;

  const SLOT = Object.freeze({ UNARMED: 0, PISTOL: 1 });
  const RADAR_RANGE = 38;
  const RADAR_FPS = 15;

  const G = TOWN.GTA07 = {
    version: 'GTA-07.1',
    initialized: false,
    slot: SLOT.PISTOL,
    SLOT: SLOT,
    els: {},
    cashLast: 0,
    cashFlash: 0,
    mapAccum: 0,
    wheelLockUntil: 0,
    attackOriginal: null,
    suppressMouse: false,
  };

  function isDriving() {
    return !!(Vehicles && Vehicles.STATES && Vehicles.state === Vehicles.STATES.DRIVING);
  }

  function ensureEconomy() {
    if (!TOWN.Economy) TOWN.Economy = { money: 0 };
    if (!isFinite(TOWN.Economy.money)) TOWN.Economy.money = 0;
    return TOWN.Economy;
  }

  function playerAnchor() {
    if (isDriving() && Vehicles.current && Vehicles.current.car) {
      return {
        x: Vehicles.current.car.position.x,
        z: Vehicles.current.car.position.z,
        yaw: Vehicles.current.car.rotation.y || 0,
      };
    }
    const st = Game.player;
    return st && st.o ? { x: st.o.position.x, z: st.o.position.z, yaw: st.yaw || 0 } : null;
  }

  function installStyle() {
    if (document.getElementById('gta07-style')) return;
    const s = document.createElement('style');
    s.id = 'gta07-style';
    s.textContent = [
      '#gta07-radar-wrap{position:fixed;left:18px;bottom:188px;z-index:151;width:174px;height:174px;border-radius:50%;',
      'background:rgba(5,8,10,.72);border:2px solid rgba(255,255,255,.23);box-shadow:0 5px 18px rgba(0,0,0,.28);overflow:hidden;pointer-events:none;display:none}',
      '#gta07-radar{display:block;width:100%;height:100%}',
      '#gta07-status{position:fixed;right:16px;top:128px;z-index:156;min-width:116px;padding:8px 10px;border-radius:8px;',
      'background:rgba(5,8,10,.68);border:1px solid rgba(255,255,255,.14);color:#fff;text-align:right;pointer-events:none;',
      'font-family:system-ui,-apple-system,sans-serif;display:none;text-shadow:0 1px 2px #000}',
      '#gta07-cash{font:800 17px/1 ui-monospace,monospace;color:#a8ef9b;transition:transform .15s ease}',
      '#gta07-cash.flash{transform:scale(1.12)}',
      '#gta07-weapon-label{margin-top:5px;font:700 10px/1 system-ui,-apple-system,sans-serif;letter-spacing:.08em;color:rgba(255,255,255,.72)}',
      '#gta07-switch{position:fixed;right:150px;bottom:174px;z-index:163;width:54px;height:54px;border-radius:999px;',
      'border:1px solid rgba(255,255,255,.24);background:rgba(12,16,20,.76);color:#fff;font:800 10px/1.08 system-ui,-apple-system,sans-serif;',
      'touch-action:none;display:none}',
      '#gta07-switch.pistol{border-color:#ffd21a;color:#ffd21a}',
      '@media(max-width:700px){#gta07-radar-wrap{left:10px;bottom:168px;width:142px;height:142px}',
      '#gta07-status{right:8px;top:116px;min-width:100px;padding:6px 8px}#gta07-cash{font-size:15px}',
      '#gta07-switch{right:148px;bottom:174px;width:54px;height:54px}}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (G.els.radar) return;

    const wrap = document.createElement('div');
    wrap.id = 'gta07-radar-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = 'gta07-radar';
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    G.els.radarWrap = wrap;
    G.els.radar = canvas;

    const status = document.createElement('div');
    status.id = 'gta07-status';
    status.innerHTML = '<div id="gta07-cash">$0</div><div id="gta07-weapon-label">武器 · 手枪</div>';
    document.body.appendChild(status);
    G.els.status = status;
    G.els.cash = status.querySelector('#gta07-cash');
    G.els.weapon = status.querySelector('#gta07-weapon-label');

    const sw = document.createElement('button');
    sw.id = 'gta07-switch';
    sw.type = 'button';
    sw.textContent = '切换\n武器';
    sw.addEventListener('pointerdown', function (e) {
      if (isDriving() || Game.mode !== 'play' || Game.settingsOpen) return;
      e.preventDefault();
      e.stopPropagation();
      G.cycleWeapon(1);
    });
    document.body.appendChild(sw);
    G.els.switcher = sw;

    const attack = document.querySelector('.actionpad [data-name="attack"]');
    if (attack) G.attackOriginal = { html: attack.innerHTML, title: attack.title };

    resizeRadar();
  }

  function resizeRadar() {
    const c = G.els.radar;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const w = Math.max(120, Math.round((rect.width || 174) * dpr));
    const h = Math.max(120, Math.round((rect.height || 174) * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  function restoreMeleeButton() {
    const b = document.querySelector('.actionpad [data-name="attack"]');
    if (!b || !G.attackOriginal || isDriving()) return;
    if (G.slot === SLOT.UNARMED) {
      if (b.dataset.gta07 !== 'melee') {
        b.innerHTML = G.attackOriginal.html;
        b.title = G.attackOriginal.title || '攻击';
        b.dataset.gta07 = 'melee';
        delete b.dataset.gta03;
      }
    } else {
      delete b.dataset.gta07;
    }
  }

  function clearWeaponAim() {
    if (!Weapons) return;
    Weapons.mouseAim = false;
    Weapons.touchAim = false;
    Weapons.aiming = false;
    Weapons.fireQueued = false;
    Weapons.reloadQueued = false;
    if (Weapons.els && Weapons.els.aim) Weapons.els.aim.classList.remove('active');
  }

  function syncWeaponPresentation() {
    const pistol = G.slot === SLOT.PISTOL;
    if (Weapons) {
      Weapons.armed = pistol;
      if (!pistol) {
        clearWeaponAim();
        if (Weapons.gun) Weapons.gun.visible = false;
        if (Weapons.els) {
          if (Weapons.els.ammo) Weapons.els.ammo.style.display = 'none';
          if (Weapons.els.aim) Weapons.els.aim.style.display = 'none';
          if (Weapons.els.reload) Weapons.els.reload.style.display = 'none';
          if (Weapons.els.crosshair) Weapons.els.crosshair.style.display = 'none';
        }
      }
    }
    restoreMeleeButton();
    if (G.els.weapon) G.els.weapon.textContent = pistol ? '武器 · 手枪' : '武器 · 徒手';
    if (G.els.switcher) {
      G.els.switcher.classList.toggle('pistol', pistol);
      G.els.switcher.textContent = pistol ? '手枪\n→徒手' : '徒手\n→手枪';
    }
  }

  G.selectWeapon = function (slot) {
    slot = slot === SLOT.UNARMED ? SLOT.UNARMED : SLOT.PISTOL;
    if (G.slot === slot) return G.slot;
    G.slot = slot;
    syncWeaponPresentation();
    return G.slot;
  };

  G.cycleWeapon = function (dir) {
    return G.selectWeapon(G.slot === SLOT.PISTOL ? SLOT.UNARMED : SLOT.PISTOL);
  };

  function installInput() {
    if (G._inputBound) return;
    G._inputBound = true;

    global.addEventListener('keydown', function (e) {
      if (Game.mode !== 'play' || Game.settingsOpen || isDriving() || e.repeat) return;
      if (e.key === '1') { G.selectWeapon(SLOT.UNARMED); e.preventDefault(); }
      else if (e.key === '2') { G.selectWeapon(SLOT.PISTOL); e.preventDefault(); }
    }, true);

    // Window capture runs before GTA-03's canvas listener. In unarmed mode this
    // prevents RMB from entering pistol aim without changing normal camera drag.
    global.addEventListener('pointerdown', function (e) {
      if (G.slot !== SLOT.UNARMED || isDriving() || Game.mode !== 'play' || Game.settingsOpen) return;
      if (e.pointerType === 'mouse' && (e.button === 2 || e.button === 0) && e.target && e.target.id === 'scene') {
        if (e.button === 2) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    }, true);

    global.addEventListener('wheel', function (e) {
      if (Game.mode !== 'play' || Game.settingsOpen || isDriving()) return;
      const now = Date.now ? Date.now() : 0;
      if (now && now < G.wheelLockUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (Math.abs(e.deltaY) < 2) return;
      G.wheelLockUntil = now ? now + 180 : 0;
      G.cycleWeapon(e.deltaY > 0 ? 1 : -1);
      // In gameplay the wheel is the weapon selector. Prevent the older
      // follow-camera wheel handler from zooming at the same time.
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { passive: false, capture: true });

    global.addEventListener('resize', resizeRadar);
  }

  function worldToRadar(x, z, anchor, radiusPx) {
    const dx = x - anchor.x;
    const dz = z - anchor.z;
    const c = Math.cos(anchor.yaw), s = Math.sin(anchor.yaw);
    const right = dx * c - dz * s;
    const forward = dx * s + dz * c;
    const scale = radiusPx / RADAR_RANGE;
    return { x: right * scale, y: -forward * scale, d2: dx * dx + dz * dz };
  }

  function drawPoint(ctx, p, cx, cy, radiusPx, size, color, shape) {
    if (!p || p.d2 > RADAR_RANGE * RADAR_RANGE * 1.18) return;
    let x = p.x, y = p.y;
    const rr = Math.hypot(x, y);
    const max = radiusPx - 6;
    if (rr > max && rr > 0) { x *= max / rr; y *= max / rr; }
    ctx.save();
    ctx.translate(cx + x, cy + y);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,.72)';
    ctx.lineWidth = 1.5;
    if (shape === 'diamond') {
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-size, -size, size * 2, size * 2);
      ctx.strokeRect(-size, -size, size * 2, size * 2);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawRoads(ctx, anchor, cx, cy, radiusPx) {
    const corridors = Roads.corridors || [];
    ctx.lineCap = 'round';
    for (let i = 0; i < corridors.length; i++) {
      const pts = corridors[i] && corridors[i].pts;
      if (!pts || pts.length < 2) continue;
      ctx.beginPath();
      let has = false;
      for (let k = 0; k < pts.length; k++) {
        const p = worldToRadar(pts[k][0], pts[k][2], anchor, radiusPx);
        const x = cx + p.x, y = cy + p.y;
        if (!has) { ctx.moveTo(x, y); has = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(220,225,230,.28)';
      ctx.lineWidth = Math.max(1.2, radiusPx / 54);
      ctx.stroke();
    }
  }

  function currentMissionPoint() {
    if (!Missions) return null;
    const obj = Missions.getObjective ? Missions.getObjective() : null;
    if (obj && obj.position) return obj.position;
    if (Missions.registry) {
      for (const id in Missions.registry) {
        const m = Missions.registry[id];
        if (m && Missions.STATES && m.state === Missions.STATES.AVAILABLE && m.start) return m.start;
      }
    }
    return null;
  }

  function forEachVehicle(fn) {
    const seen = new Set();
    const systems = Dynamics._systems;
    const veh = systems && systems.VEH ? systems.VEH : [];
    const tmp = global.THREE ? new global.THREE.Vector3() : null;
    for (let i = 0; i < veh.length; i++) {
      const m = veh[i];
      if (!m || !m.parts) continue;
      for (let k = 0; k < m.parts.length; k++) {
        const o = m.parts[k] && m.parts[k].o;
        if (!o || !o.visible || !o.userData || o.userData.kind !== 'car' || seen.has(o)) continue;
        seen.add(o);
        if (tmp && o.getWorldPosition) { o.getWorldPosition(tmp); fn(tmp.x, tmp.z, o); }
        else fn(o.position.x, o.position.z, o);
      }
    }
    if (Vehicles && Vehicles.parked) {
      for (let i = 0; i < Vehicles.parked.length; i++) {
        const o = Vehicles.parked[i] && Vehicles.parked[i].car;
        if (!o || seen.has(o)) continue;
        seen.add(o); fn(o.position.x, o.position.z, o);
      }
    }
    if (Vehicles && Vehicles.current && Vehicles.current.car && !seen.has(Vehicles.current.car)) {
      const o = Vehicles.current.car; fn(o.position.x, o.position.z, o);
    }
  }

  function drawRadar() {
    const canvas = G.els.radar;
    const anchor = playerAnchor();
    if (!canvas || !anchor) return;
    resizeRadar();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    const cx = w * 0.5, cy = h * 0.5;
    const radius = Math.min(w, h) * 0.5 - 4;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(11,16,20,.94)'; ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    for (let r = 0.33; r < 1; r += 0.33) {
      ctx.beginPath(); ctx.arc(cx, cy, radius * r, 0, Math.PI * 2); ctx.stroke();
    }

    drawRoads(ctx, anchor, cx, cy, radius);

    const mission = currentMissionPoint();
    if (mission) drawPoint(ctx, worldToRadar(mission.x, mission.z, anchor, radius), cx, cy, radius, radius * 0.026, '#ffd21a', 'diamond');

    forEachVehicle(function (x, z) {
      drawPoint(ctx, worldToRadar(x, z, anchor, radius), cx, cy, radius, radius * 0.016, '#d8e3e9', 'circle');
    });

    if (EnemyAI && EnemyAI.enemies) {
      for (let i = 0; i < EnemyAI.enemies.length; i++) {
        const e = EnemyAI.enemies[i];
        if (!e || !e.o || !e.o.visible || (EnemyAI.STATES && e.state === EnemyAI.STATES.DEAD)) continue;
        drawPoint(ctx, worldToRadar(e.o.position.x, e.o.position.z, anchor, radius), cx, cy, radius, radius * 0.019, '#e64b43', 'circle');
      }
    }

    if (Wanted && Wanted.police) {
      for (let i = 0; i < Wanted.police.length; i++) {
        const p = Wanted.police[i];
        if (!p || !p.o || !p.o.visible || (Wanted.POLICE_STATES && p.state === Wanted.POLICE_STATES.DEAD)) continue;
        drawPoint(ctx, worldToRadar(p.o.position.x, p.o.position.z, anchor, radius), cx, cy, radius, radius * 0.019, '#62a9ff', 'circle');
      }
    }

    ctx.save(); ctx.translate(cx, cy);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = Math.max(1.3, radius * 0.010);
    const ah = radius * 0.052, aw = radius * 0.034;
    ctx.beginPath(); ctx.moveTo(0, -ah); ctx.lineTo(aw, ah * 0.72); ctx.lineTo(0, ah * 0.40); ctx.lineTo(-aw, ah * 0.72); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();

    const north = worldToRadar(anchor.x, anchor.z + 1, anchor, radius);
    const nl = Math.hypot(north.x, north.y) || 1;
    const nr = radius - Math.max(11, radius * 0.10);
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.font = Math.max(9, Math.round(radius / 8)) + 'px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cx + north.x / nl * nr, cy + north.y / nl * nr);
  }

  function updateCash(dt) {
    const eco = ensureEconomy();
    const money = Math.max(0, Math.floor(eco.money || 0));
    if (money !== G.cashLast) {
      G.cashLast = money;
      G.cashFlash = 0.45;
      if (G.els.cash) G.els.cash.textContent = '$' + money.toLocaleString('en-US');
    }
    G.cashFlash = Math.max(0, G.cashFlash - dt);
    if (G.els.cash) G.els.cash.classList.toggle('flash', G.cashFlash > 0);
  }

  function syncHUD(dt) {
    const active = Game.mode === 'play' && !Game.settingsOpen && !!Game.player;
    if (G.els.radarWrap) G.els.radarWrap.style.display = active ? 'block' : 'none';
    if (G.els.status) G.els.status.style.display = active ? 'block' : 'none';
    if (G.els.switcher) G.els.switcher.style.display = active && !isDriving() ? 'block' : 'none';
    if (!active) return;
    updateCash(dt);
    syncWeaponPresentation();
  }

  function updateRadar(dt) {
    G.mapAccum += dt;
    if (G.mapAccum < 1 / RADAR_FPS) return;
    G.mapAccum = 0;
    drawRadar();
  }

  G.init = function () {
    if (G.initialized) return;
    G.initialized = true;
    ensureEconomy();
    installStyle();
    installDOM();
    installInput();
    G.cashLast = Math.floor(TOWN.Economy.money || 0);
    if (G.els.cash) G.els.cash.textContent = '$' + G.cashLast.toLocaleString('en-US');
    syncWeaponPresentation();
    console.log('[GTA-07] minimap / economy / weapon switching ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    G.init();
    return out;
  };

  const baseUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!G.initialized) G.init();

    let sentinel = false;
    let savedDlg = null;
    if (G.slot === SLOT.UNARMED && !isDriving() && Game.input && Game.input.state && Game.input.state.attackPressed && !Game._dlgNpc) {
      savedDlg = Game._dlgNpc;
      Game._dlgNpc = G;
      sentinel = true;
    }

    const out = baseUpdate.call(Game, dt, elapsed);

    if (sentinel && Game._dlgNpc === G) Game._dlgNpc = savedDlg;
    syncHUD(dt);
    if (Game.mode === 'play' && !Game.settingsOpen && Game.player) updateRadar(dt);
    return out;
  };
})(window);
