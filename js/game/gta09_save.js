/* =============================================================
   js/game/gta09_save.js — GTA-09 local save / continue v1

   Local-only persistence. No network requests or cloud upload.
   Saves compact JSON state to localStorage and rebuilds transient world
   objects (traffic, police, ambient enemies) on every page load.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const Missions = TOWN.Missions;
  const Weapons = TOWN.Weapons;
  const EnemyAI = TOWN.EnemyAI;
  const GTA05 = TOWN.GTA05;
  const GTA07 = TOWN.GTA07;
  const Wanted = TOWN.Wanted;
  const Collision = TOWN.CollisionV1;
  const Island = TOWN.Island;
  const App = TOWN.App;

  const SAVE_KEY = 'box-court-gta.save.v1';
  const SAVE_VERSION = 1;
  const AUTOSAVE_MS = 25000;

  const S = TOWN.SaveGame = {
    version: 'GTA-09.1',
    initialized: false,
    available: false,
    pendingRestore: false,
    lastSaveAt: 0,
    lastError: null,
    timer: 0,
    els: {},
  };

  function finite(v, fallback) {
    v = Number(v);
    return isFinite(v) ? v : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function storageGet() {
    try { return global.localStorage ? global.localStorage.getItem(SAVE_KEY) : null; }
    catch (e) { S.lastError = e; return null; }
  }

  function storageSet(value) {
    try {
      if (!global.localStorage) return false;
      global.localStorage.setItem(SAVE_KEY, value);
      return true;
    } catch (e) {
      S.lastError = e;
      return false;
    }
  }

  function storageRemove() {
    try {
      if (global.localStorage) global.localStorage.removeItem(SAVE_KEY);
      return true;
    } catch (e) {
      S.lastError = e;
      return false;
    }
  }

  function parseSave(raw) {
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      if (!d || d.version !== SAVE_VERSION || !d.player) return null;
      if (!isFinite(Number(d.player.x)) || !isFinite(Number(d.player.z))) return null;
      return d;
    } catch (_) {
      return null;
    }
  }

  function readSave() {
    return parseSave(storageGet());
  }

  function missionSnapshot() {
    const out = { current: null, registry: {} };
    if (!Missions || !Missions.registry) return out;
    out.current = Missions.current ? Missions.current.id : null;
    for (const id in Missions.registry) {
      const m = Missions.registry[id];
      if (!m) continue;
      out.registry[id] = {
        state: m.state,
        objectiveIndex: m.objectiveIndex | 0,
      };
    }
    return out;
  }

  function buildSave() {
    if (!Game.player || !Game.player.o || Game.mode !== 'play') return null;

    // vehicles.js continuously mirrors the hidden player to the controlled car,
    // so this position is also the correct resume anchor while driving.
    const p = Game.player.o.position;
    const data = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      player: {
        x: finite(p.x, 0),
        y: finite(p.y, 0),
        z: finite(p.z, 0),
        yaw: finite(Game.player.yaw, 0),
        health: EnemyAI ? clamp(finite(EnemyAI.playerHealth, 100), 1, finite(EnemyAI.playerMaxHealth, 100)) : 100,
        wasDriving: !!(TOWN.Vehicles && TOWN.Vehicles.STATES && TOWN.Vehicles.state === TOWN.Vehicles.STATES.DRIVING),
      },
      economy: {
        money: TOWN.Economy ? Math.max(0, finite(TOWN.Economy.money, 0)) : 0,
      },
      weapons: {
        slot: GTA07 ? (GTA07.slot | 0) : 1,
        ammo: Weapons ? Math.max(0, Weapons.ammo | 0) : 12,
        reserve: Weapons ? Math.max(0, Weapons.reserve | 0) : 48,
      },
      missions: missionSnapshot(),
      gta05: GTA05 ? {
        rewardGranted: !!GTA05.rewardGranted,
        killCount: clamp(GTA05.killCount | 0, 0, 3),
        killed: Object.assign({}, GTA05.killed || {}),
      } : null,
      world: {
        hours: App ? finite(App.hours, 8.4) : 8.4,
      },
      camera: Game.cam ? {
        yaw: finite(Game.cam.curYaw, NaN),
        pitch: finite(Game.cam.curPitch, NaN),
        dist: finite(Game.cam.curDist, NaN),
      } : null,
    };
    return data;
  }

  function updateContinueButton() {
    const d = readSave();
    S.available = !!d;
    const b = S.els.continueBtn;
    if (!b) return;
    b.disabled = !d;
    b.classList.toggle('disabled', !d);
    if (!d) {
      b.textContent = '继续游戏';
      b.title = '暂无本地存档';
      return;
    }
    const money = d.economy ? Math.max(0, d.economy.money | 0) : 0;
    b.textContent = '继续游戏';
    b.title = '本地存档 · $' + money;
  }

  S.save = function (reason) {
    const data = buildSave();
    if (!data) return false;
    const ok = storageSet(JSON.stringify(data));
    if (ok) {
      S.lastSaveAt = data.savedAt;
      S.available = true;
      updateContinueButton();
      if (reason !== 'autosave') console.log('[GTA-09] local save:', reason || 'manual');
    }
    return ok;
  };

  S.clear = function () {
    const ok = storageRemove();
    S.available = false;
    updateContinueButton();
    return ok;
  };

  function groundAt(x, z, fallbackY) {
    let s = null;
    if (Collision && Collision.sample) s = Collision.sample(x, z);
    else if (Island && Island.sample) s = Island.sample(x, z);
    if (s && s.land && isFinite(s.y)) return s.y;
    return finite(fallbackY, 0);
  }

  function restoreMissions(data) {
    if (!Missions || !data || !data.registry) return;
    const validStates = Missions.STATES || {};
    const stateSet = new Set(Object.keys(validStates).map(function (k) { return validStates[k]; }));

    for (const id in data.registry) {
      const saved = data.registry[id];
      const m = Missions.get ? Missions.get(id) : (Missions.registry && Missions.registry[id]);
      if (!m || !saved) continue;
      if (stateSet.has(saved.state)) m.state = saved.state;
      m.objectiveIndex = clamp(saved.objectiveIndex | 0, 0, Math.max(0, m.objectives.length - 1));
      if (m.state === validStates.COMPLETED) m.objectiveIndex = m.objectives.length;
    }

    Missions.current = null;
    if (data.current) {
      const m = Missions.get ? Missions.get(data.current) : null;
      if (m && m.state === validStates.ACTIVE) Missions.current = m;
    }
  }

  function markRestoredGTA05Kills(saved) {
    if (!saved || !EnemyAI || !EnemyAI.enemies || !GTA05 || !GTA05.combatActive) return false;
    const killed = saved.killed || {};
    for (let i = 0; i < EnemyAI.enemies.length; i++) {
      const en = EnemyAI.enemies[i];
      if (!en || !en.o) continue;
      const key = String(en.id === undefined ? en.o.uuid : en.id);
      if (!killed[key]) continue;
      en.hp = 0;
      en.state = EnemyAI.STATES.DEAD;
      en.aggro = false;
      en.swingTimer = 0;
      en.o.userData.gta04Dead = true;
      en.o.userData.gta04Health = 0;
      en.o.userData.gta05Target = true;
      if (en.bar && en.bar.el) en.bar.el.style.display = 'none';
      const list = Game.npcs || [];
      const idx = list.indexOf(en.o);
      if (idx >= 0) list.splice(idx, 1);
    }
    return true;
  }

  function restoreGTA05(data) {
    if (!GTA05 || !data) return;
    GTA05.rewardGranted = !!data.rewardGranted;
    GTA05.killCount = clamp(data.killCount | 0, 0, 3);
    GTA05.killed = Object.assign(Object.create(null), data.killed || {});

    // GTA-05 activates its combat pool from the restored objective on update.
    // Once that pool exists, mirror previously killed targets back to DEAD.
    if (GTA05.killCount > 0 && !GTA05.rewardGranted) {
      let tries = 0;
      const apply = function () {
        tries++;
        if (markRestoredGTA05Kills(data) || tries > 60) return;
        global.requestAnimationFrame(apply);
      };
      global.requestAnimationFrame(apply);
    }
  }

  function restoreCamera(data) {
    if (!data || !Game.cam) return;
    if (isFinite(data.yaw) && 'curYaw' in Game.cam) Game.cam.curYaw = data.yaw;
    if (isFinite(data.pitch) && 'curPitch' in Game.cam) Game.cam.curPitch = data.pitch;
    if (isFinite(data.dist) && 'curDist' in Game.cam) Game.cam.curDist = data.dist;
    if (Game.cam.snap) Game.cam.snap();
  }

  S.restore = function () {
    const data = readSave();
    if (!data || !Game.player || !Game.player.o) return false;

    const x = finite(data.player.x, Game.player.o.position.x);
    const z = finite(data.player.z, Game.player.o.position.z);
    const y = groundAt(x, z, data.player.y);
    Game.player.o.position.set(x, y, z);
    Game.player.yaw = finite(data.player.yaw, Game.player.yaw || 0);
    Game.player.moveYaw = Game.player.yaw;
    Game.player.o.rotation.y = Game.player.yaw;
    Game.player.vy = 0;
    Game.player.speed = 0;
    Game.player.onGround = true;

    if (EnemyAI) {
      EnemyAI.playerHealth = clamp(finite(data.player.health, EnemyAI.playerMaxHealth), 1, EnemyAI.playerMaxHealth);
      EnemyAI.playerDownTimer = 0;
      EnemyAI.graceTimer = Math.max(EnemyAI.graceTimer || 0, 1.5);
    }

    if (!TOWN.Economy) TOWN.Economy = { money: 0 };
    TOWN.Economy.money = data.economy ? Math.max(0, finite(data.economy.money, 0)) : 0;

    if (Weapons && data.weapons) {
      Weapons.ammo = clamp(data.weapons.ammo | 0, 0, Weapons.magSize || 12);
      Weapons.reserve = Math.max(0, data.weapons.reserve | 0);
      Weapons.reloadTimer = 0;
      Weapons.reloadQueued = false;
      Weapons.fireQueued = false;
    }
    if (GTA07 && data.weapons && GTA07.selectWeapon) GTA07.selectWeapon(data.weapons.slot | 0);

    restoreMissions(data.missions);
    restoreGTA05(data.gta05);

    if (App && data.world) {
      App.hours = ((finite(data.world.hours, App.hours) % 24) + 24) % 24;
      if (TOWN.Sky && TOWN.Sky.setHours) TOWN.Sky.setHours(App.hours);
    }

    // Pursuit actors are intentionally transient; continue from a clean police state.
    if (Wanted && Wanted.clear) Wanted.clear(true);

    restoreCamera(data.camera);
    S.pendingRestore = false;
    console.log('[GTA-09] continued local save from', new Date(data.savedAt || Date.now()).toLocaleString());
    return true;
  };

  function installStyle() {
    if (document.getElementById('gta09-style')) return;
    const s = document.createElement('style');
    s.id = 'gta09-style';
    s.textContent = [
      '#btn-continue.disabled,#btn-continue:disabled{opacity:.38;cursor:default;filter:saturate(.5)}',
      '#gta09-save-note{margin-top:12px;font-size:10px;letter-spacing:.06em;color:rgba(42,38,34,.48)}'
    ].join('');
    document.head.appendChild(s);
  }

  function installMenu() {
    const start = document.getElementById('start-screen');
    const startBtn = document.getElementById('btn-start');
    const actions = start && start.querySelector('.screen-actions');
    if (!startBtn || !actions || S.els.continueBtn) return;

    startBtn.textContent = '新游戏';
    startBtn.classList.remove('primary');

    const cont = document.createElement('button');
    cont.id = 'btn-continue';
    cont.className = 'btn primary';
    cont.type = 'button';
    cont.textContent = '继续游戏';
    actions.insertBefore(cont, startBtn);
    S.els.continueBtn = cont;

    const note = document.createElement('div');
    note.id = 'gta09-save-note';
    note.textContent = '进度保存在此浏览器设备中 · 不上传网络';
    actions.parentNode.insertBefore(note, actions.nextSibling);
    S.els.note = note;

    // Capture runs before shell.js's normal click handler.
    startBtn.addEventListener('click', function (e) {
      if (!readSave()) return;
      const ok = global.confirm('开始新游戏将覆盖当前本地进度。确定继续吗？');
      if (!ok) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      S.clear();
    }, true);

    cont.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!readSave()) { updateContinueButton(); return; }
      S.pendingRestore = true;
      startBtn.click();
      global.requestAnimationFrame(function () {
        global.requestAnimationFrame(function () { S.restore(); });
      });
    });

    updateContinueButton();
  }

  function installSaveHooks() {
    if (S._hooksBound) return;
    S._hooksBound = true;

    S.timer = global.setInterval(function () {
      if (Game.mode === 'play' && Game.player && !Game.settingsOpen) S.save('autosave');
    }, AUTOSAVE_MS);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') S.save('background');
    });
    global.addEventListener('pagehide', function () { S.save('pagehide'); });
    global.addEventListener('beforeunload', function () { S.save('beforeunload'); });

    if (Missions && Missions.completeObjective && !Missions.completeObjective.__gta09Wrapped) {
      const base = Missions.completeObjective;
      const wrapped = function () {
        const out = base.apply(Missions, arguments);
        if (out) S.save('mission');
        return out;
      };
      wrapped.__gta09Wrapped = true;
      Missions.completeObjective = wrapped;
    }

    if (GTA07 && GTA07.selectWeapon && !GTA07.selectWeapon.__gta09Wrapped) {
      const baseSelect = GTA07.selectWeapon;
      const wrappedSelect = function () {
        const out = baseSelect.apply(GTA07, arguments);
        if (Game.mode === 'play') S.save('weapon');
        return out;
      };
      wrappedSelect.__gta09Wrapped = true;
      GTA07.selectWeapon = wrappedSelect;
    }
  }

  S.init = function () {
    if (S.initialized) return;
    S.initialized = true;
    installStyle();
    installMenu();
    installSaveHooks();
    console.log('[GTA-09] local save system ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    S.init();
    return out;
  };
})(window);
