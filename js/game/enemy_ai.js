/* =============================================================
   js/game/enemy_ai.js — GTA-04 enemy AI

   GTA-04 scope:
   - spawn a small hostile test group from the existing person builder;
   - detect / chase the on-foot player with lightweight local steering;
   - melee attack and player health;
   - consume GTA-03 hit counters, apply health and death;
   - enemyKilled mission event for GTA-05 integration.

   No police, wanted level, firearms for enemies, cover system or navmesh.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Game || !TOWN.Dynamics) return;

  const Game = TOWN.Game;
  const Dyn = TOWN.Dynamics;
  const U = TOWN.U;
  const C = TOWN.CollisionV1;
  const Island = TOWN.Island;
  const Missions = TOWN.Missions;
  const Vehicles = TOWN.Vehicles;

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    CHASE: 'CHASE',
    ATTACK: 'ATTACK',
    DEAD: 'DEAD',
  });

  const E = TOWN.EnemyAI = {
    version: 'GTA-04.1',
    STATES: STATES,
    initialized: false,
    spawned: false,
    enemies: [],
    playerHealth: 100,
    playerMaxHealth: 100,
    playerDownTimer: 0,
    graceTimer: 0,
    spawnOrigin: null,
    els: {},
  };

  const ENEMY_COUNT = 4;
  const DETECT_RANGE = 17.0;
  const LOSE_RANGE = 28.0;
  const ATTACK_RANGE = 1.58;
  const CHASE_SPEED = 2.85;
  const ENEMY_MAX_HP = 100;
  const PISTOL_DAMAGE = 34;
  const ENEMY_DAMAGE = 12;
  const ENEMY_RADIUS = 0.40;
  const MAX_STEP = 0.50;

  const tmpScreen = new T.Vector3();

  function isDriving() {
    return !!(Vehicles && Vehicles.STATES && Vehicles.state === Vehicles.STATES.DRIVING);
  }

  function sampleGround(x, z) {
    if (C && C.sample) return C.sample(x, z);
    return Island && Island.sample ? Island.sample(x, z) : { y: 0, land: true };
  }

  function pointBlocked(x, z, radius) {
    if (!C || !C.solids || !C.solids.length) return false;
    const solids = C.solids;
    const r = radius || 0;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (!s) continue;
      const dx = x - s.x, dz = z - s.z;
      const rr = (s.r || Math.hypot(s.w || 0, s.d || 0) * 0.5) + r;
      if (dx * dx + dz * dz > rr * rr) continue;
      const co = Math.cos(s.rot || 0), si = Math.sin(s.rot || 0);
      const lx = co * dx - si * dz;
      const lz = si * dx + co * dz;
      if (Math.abs(lx) < (s.w || 0) * 0.5 + r &&
          Math.abs(lz) < (s.d || 0) * 0.5 + r) return true;
    }
    return false;
  }

  function validStep(x, z, fromY) {
    if (pointBlocked(x, z, ENEMY_RADIUS)) return null;
    const s = sampleGround(x, z);
    if (!s || !s.land || !isFinite(s.y)) return null;
    if (isFinite(fromY) && Math.abs(s.y - fromY) > MAX_STEP) return null;
    return s;
  }

  function installStyle() {
    if (document.getElementById('gta04-style')) return;
    const style = document.createElement('style');
    style.id = 'gta04-style';
    style.textContent = [
      '#gta04-player-hp{position:fixed;left:18px;bottom:22px;z-index:158;width:180px;padding:7px 9px;border-radius:8px;background:rgba(5,8,10,.70);border:1px solid rgba(255,255,255,.16);color:#fff;font:700 10px/1 system-ui,sans-serif;display:none;pointer-events:none}',
      '#gta04-player-hp .row{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}',
      '#gta04-player-hp .bar{height:7px;border-radius:5px;background:rgba(255,255,255,.13);overflow:hidden}',
      '#gta04-player-hp .bar i{display:block;height:100%;width:100%;background:#e35345;transform-origin:left center}',
      '#gta04-down{position:fixed;left:50%;top:43%;transform:translate(-50%,-50%);z-index:180;padding:14px 18px;border-radius:9px;background:rgba(10,12,14,.82);border:1px solid rgba(255,90,70,.55);color:#fff;font:800 20px/1 system-ui,sans-serif;letter-spacing:.08em;display:none;pointer-events:none}',
      '.gta04-enemy-hp{position:fixed;z-index:157;width:64px;height:7px;transform:translate(-50%,-100%);border:1px solid rgba(255,255,255,.25);border-radius:4px;background:rgba(0,0,0,.64);overflow:hidden;pointer-events:none;display:none}',
      '.gta04-enemy-hp i{display:block;height:100%;width:100%;background:#d93f36;transform-origin:left center}',
      '@media(max-width:700px){#gta04-player-hp{left:10px;bottom:12px;width:145px;padding:6px 8px}.gta04-enemy-hp{width:54px;height:6px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function installDOM() {
    if (E.els.player) return;
    const hp = document.createElement('div');
    hp.id = 'gta04-player-hp';
    hp.innerHTML = '<div class="row"><span>生命</span><b>100</b></div><div class="bar"><i></i></div>';
    document.body.appendChild(hp);
    E.els.player = hp;
    E.els.playerNum = hp.querySelector('b');
    E.els.playerFill = hp.querySelector('.bar i');

    const down = document.createElement('div');
    down.id = 'gta04-down';
    down.textContent = '重伤倒地';
    document.body.appendChild(down);
    E.els.down = down;
  }

  function makeEnemyBar() {
    const el = document.createElement('div');
    el.className = 'gta04-enemy-hp';
    el.innerHTML = '<i></i>';
    document.body.appendChild(el);
    return { el: el, fill: el.querySelector('i') };
  }

  function captureLimbBases(limbs) {
    const out = [];
    for (let i = 0; i < (limbs ? limbs.length : 0); i++) {
      const l = limbs[i];
      out.push(l ? { x: l.rotation.x, y: l.rotation.y, z: l.rotation.z } : null);
    }
    return out;
  }

  function restoreLimb(enemy, idx) {
    const limb = enemy.limbs && enemy.limbs[idx];
    const base = enemy.limbBase && enemy.limbBase[idx];
    if (!limb || !base) return;
    limb.rotation.x = base.x;
    limb.rotation.y = base.y;
    limb.rotation.z = base.z;
  }

  function findSpawn(index) {
    const p = Game.player.o.position;
    const baseAngles = [0.30, 1.95, 3.45, 5.05];
    const base = baseAngles[index % baseAngles.length];
    const radii = [15, 18, 21, 24, 27];
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      for (let ai = 0; ai < 8; ai++) {
        const a = base + ai * Math.PI / 4;
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        const s = validStep(x, z, NaN);
        if (!s) continue;
        let tooClose = false;
        for (let k = 0; k < E.enemies.length; k++) {
          const q = E.enemies[k].o.position;
          const dx = q.x - x, dz = q.z - z;
          if (dx * dx + dz * dz < 16) { tooClose = true; break; }
        }
        if (!tooClose) return { x: x, y: s.y, z: z };
      }
    }
    const s = sampleGround(p.x + 12 + index * 1.5, p.z + 10);
    return { x: p.x + 12 + index * 1.5, y: s.y || p.y, z: p.z + 10 };
  }

  function spawnEnemy(index) {
    const built = Dyn.buildPerson(U.rng(404040 + index * 977), 1.02, false);
    const o = built.o;
    const pos = findSpawn(index);
    o.position.set(pos.x, pos.y, pos.z);
    o.rotation.y = index * 1.7;
    o.name = 'gta04-enemy-' + (index + 1);
    o.userData.kind = 'pedestrian';
    o.userData.gta04Enemy = true;
    o.userData.gta04Dead = false;
    o.userData.gta04Health = ENEMY_MAX_HP;
    o.userData.gta03Hits = 0;
    o.userData.name = '敌人' + (index + 1);
    o.userData.line = '……';
    o.userData.npcId = 4000 + index;
    o.userData.limbs = built.limbs;
    o.userData.torso = built.torso;
    TOWN.markDynamic(o);
    TOWN.Stage.scene.add(o);

    const bar = makeEnemyBar();
    const enemy = {
      id: index + 1,
      o: o,
      limbs: built.limbs,
      torso: built.torso,
      limbBase: captureLimbBases(built.limbs),
      state: STATES.IDLE,
      hp: ENEMY_MAX_HP,
      maxHp: ENEMY_MAX_HP,
      lastGunHits: 0,
      aggro: false,
      walkPhase: index * 1.3,
      attackCooldown: 0.30 + index * 0.17,
      swingTimer: 0,
      swingHit: false,
      hurtTimer: 0,
      deadLean: index % 2 ? -1 : 1,
      bar: bar,
    };
    E.enemies.push(enemy);

    if (!Game.npcs) Game.npcs = [];
    Game.npcs.push(o);
    return enemy;
  }

  function spawnEnemies() {
    if (E.spawned || !Game.player || !Game.player.o) return;
    if (C && C.init) C.init();
    E.spawnOrigin = Game.player.o.position.clone();
    for (let i = 0; i < ENEMY_COUNT; i++) spawnEnemy(i);
    E.spawned = true;
    console.log('[GTA-04] enemies spawned:', E.enemies.length);
  }

  function removeFromNPCTargets(o) {
    const list = Game.npcs || [];
    const idx = list.indexOf(o);
    if (idx >= 0) list.splice(idx, 1);
  }

  function killEnemy(enemy) {
    if (!enemy || enemy.state === STATES.DEAD) return;
    enemy.hp = 0;
    enemy.state = STATES.DEAD;
    enemy.aggro = false;
    enemy.swingTimer = 0;
    enemy.o.userData.gta04Dead = true;
    enemy.o.userData.gta04Health = 0;
    removeFromNPCTargets(enemy.o);
    if (enemy.bar && enemy.bar.el) enemy.bar.el.style.display = 'none';

    if (Missions && Missions.emit) {
      Missions.emit('enemyKilled', {
        enemy: enemy.o,
        enemyId: enemy.id,
        weapon: 'pistol',
        position: enemy.o.position.clone(),
      });
    }
  }

  function consumeWeaponHits(enemy) {
    if (!enemy || enemy.state === STATES.DEAD) return;
    const hits = enemy.o.userData.gta03Hits | 0;
    if (hits <= enemy.lastGunHits) return;
    const delta = hits - enemy.lastGunHits;
    enemy.lastGunHits = hits;
    enemy.hp = Math.max(0, enemy.hp - delta * PISTOL_DAMAGE);
    enemy.o.userData.gta04Health = enemy.hp;
    enemy.aggro = true;
    enemy.hurtTimer = 0.22;
    if (enemy.hp <= 0) killEnemy(enemy);
  }

  function damagePlayer(amount) {
    if (E.playerDownTimer > 0 || E.graceTimer > 0) return;
    E.playerHealth = Math.max(0, E.playerHealth - amount);
    if (E.playerHealth <= 0) {
      E.playerDownTimer = 2.0;
      E.graceTimer = 0;
      if (E.els.down) E.els.down.style.display = 'block';
      for (let i = 0; i < E.enemies.length; i++) {
        E.enemies[i].swingTimer = 0;
        E.enemies[i].attackCooldown = 1.5;
      }
    }
  }

  function respawnPlayer() {
    if (!Game.player || !E.spawnOrigin) return;
    const st = Game.player;
    const s = sampleGround(E.spawnOrigin.x, E.spawnOrigin.z);
    st.o.position.set(E.spawnOrigin.x, s && isFinite(s.y) ? s.y : E.spawnOrigin.y, E.spawnOrigin.z);
    if (st.vel && st.vel.set) st.vel.set(0, 0, 0);
    st.vy = 0;
    st.speed = 0;
    st.onGround = true;
    E.playerHealth = E.playerMaxHealth;
    E.playerDownTimer = 0;
    E.graceTimer = 2.0;
    if (E.els.down) E.els.down.style.display = 'none';

    for (let i = 0; i < E.enemies.length; i++) {
      const en = E.enemies[i];
      if (en.state === STATES.DEAD) continue;
      en.aggro = false;
      en.state = STATES.IDLE;
      en.swingTimer = 0;
      en.attackCooldown = 1.0;
    }
  }

  function facePlayer(enemy, dx, dz, dt) {
    const target = Math.atan2(dx, dz);
    let diff = U.mod(target - enemy.o.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    enemy.o.rotation.y += diff * Math.min(1, dt * 8.5);
  }

  function separateDirection(enemy, dx, dz) {
    let sx = 0, sz = 0;
    for (let i = 0; i < E.enemies.length; i++) {
      const other = E.enemies[i];
      if (other === enemy || other.state === STATES.DEAD) continue;
      const ox = enemy.o.position.x - other.o.position.x;
      const oz = enemy.o.position.z - other.o.position.z;
      const d2 = ox * ox + oz * oz;
      if (d2 < 0.01 || d2 > 1.65 * 1.65) continue;
      const dist = Math.sqrt(d2);
      const inv = 1 / dist;
      const push = (1.65 - dist) * 0.55;
      sx += ox * inv * push;
      sz += oz * inv * push;
    }
    dx += sx; dz += sz;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  function tryMove(enemy, dirX, dirZ, dt) {
    const o = enemy.o;
    const step = CHASE_SPEED * dt;
    const angles = [0, 0.58, -0.58, 1.02, -1.02];
    const baseA = Math.atan2(dirZ, dirX);
    for (let i = 0; i < angles.length; i++) {
      const a = baseA + angles[i];
      const vx = Math.cos(a), vz = Math.sin(a);
      const nx = o.position.x + vx * step;
      const nz = o.position.z + vz * step;
      const s = validStep(nx, nz, o.position.y);
      if (!s) continue;
      o.position.x = nx;
      o.position.z = nz;
      o.position.y = s.y;
      return true;
    }
    return false;
  }

  function animateEnemy(enemy, dt, moving) {
    const limbs = enemy.limbs;
    if (!limbs) return;

    if (enemy.state === STATES.DEAD) {
      for (let i = 0; i < limbs.length; i++) restoreLimb(enemy, i);
      enemy.o.rotation.z += (enemy.deadLean * 1.36 - enemy.o.rotation.z) * Math.min(1, dt * 7);
      enemy.o.rotation.x += (0.08 - enemy.o.rotation.x) * Math.min(1, dt * 5);
      return;
    }

    enemy.o.rotation.z *= Math.max(0, 1 - dt * 12);
    enemy.o.rotation.x *= Math.max(0, 1 - dt * 12);

    if (moving) {
      enemy.walkPhase += dt * CHASE_SPEED * 5.0;
      const sw = Math.sin(enemy.walkPhase) * 0.58;
      if (limbs[0] && enemy.limbBase[0]) limbs[0].rotation.x = enemy.limbBase[0].x + sw;
      if (limbs[1] && enemy.limbBase[1]) limbs[1].rotation.x = enemy.limbBase[1].x - sw;
      if (limbs[2] && enemy.limbBase[2]) limbs[2].rotation.x = enemy.limbBase[2].x - sw * 0.72;
      if (limbs[3] && enemy.limbBase[3]) limbs[3].rotation.x = enemy.limbBase[3].x + sw * 0.72;
    } else {
      for (let i = 0; i < limbs.length; i++) {
        const l = limbs[i], b = enemy.limbBase[i];
        if (!l || !b) continue;
        l.rotation.x += (b.x - l.rotation.x) * Math.min(1, dt * 8);
        l.rotation.y += (b.y - l.rotation.y) * Math.min(1, dt * 8);
        l.rotation.z += (b.z - l.rotation.z) * Math.min(1, dt * 8);
      }
    }

    if (enemy.swingTimer > 0 && limbs[3]) {
      const p = 1 - enemy.swingTimer / 0.48;
      const punch = Math.sin(U.clamp(p, 0, 1) * Math.PI);
      const b = enemy.limbBase[3];
      limbs[3].rotation.x = (b ? b.x : 0) - 1.15 * punch;
      limbs[3].rotation.z = (b ? b.z : 0) - 0.18 * punch;
    }

    if (enemy.hurtTimer > 0) {
      const k = enemy.hurtTimer / 0.22;
      enemy.o.rotation.z += Math.sin((1 - k) * Math.PI) * 0.16 * enemy.deadLean;
    }
  }

  function updateEnemy(enemy, dt) {
    consumeWeaponHits(enemy);
    if (enemy.state === STATES.DEAD) {
      animateEnemy(enemy, dt, false);
      return;
    }

    enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt);
    enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
    if (enemy.swingTimer > 0) {
      const before = enemy.swingTimer;
      enemy.swingTimer = Math.max(0, enemy.swingTimer - dt);
      if (!enemy.swingHit && before > 0.25 && enemy.swingTimer <= 0.25) {
        enemy.swingHit = true;
        if (Game.player && E.playerDownTimer <= 0 && !isDriving()) {
          const dx = Game.player.o.position.x - enemy.o.position.x;
          const dz = Game.player.o.position.z - enemy.o.position.z;
          if (dx * dx + dz * dz <= 1.92 * 1.92) damagePlayer(ENEMY_DAMAGE);
        }
      }
    }

    if (!Game.player || isDriving() || E.playerDownTimer > 0 || E.graceTimer > 0) {
      enemy.state = STATES.IDLE;
      animateEnemy(enemy, dt, false);
      return;
    }

    const pp = Game.player.o.position;
    const dx = pp.x - enemy.o.position.x;
    const dz = pp.z - enemy.o.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= DETECT_RANGE) enemy.aggro = true;
    else if (dist > LOSE_RANGE && enemy.swingTimer <= 0) enemy.aggro = false;

    if (!enemy.aggro) {
      enemy.state = STATES.IDLE;
      animateEnemy(enemy, dt, false);
      return;
    }

    facePlayer(enemy, dx, dz, dt);

    if (dist <= ATTACK_RANGE) {
      enemy.state = STATES.ATTACK;
      if (enemy.attackCooldown <= 0 && enemy.swingTimer <= 0) {
        enemy.swingTimer = 0.48;
        enemy.swingHit = false;
        enemy.attackCooldown = 1.05;
      }
      animateEnemy(enemy, dt, false);
      return;
    }

    enemy.state = STATES.CHASE;
    const sep = separateDirection(enemy, dx, dz);
    const moved = tryMove(enemy, sep.x, sep.z, dt);
    animateEnemy(enemy, dt, moved);
  }

  function updateEnemyBars() {
    const cam = TOWN.Stage && TOWN.Stage.camera;
    if (!cam || !Game.player) return;
    const px = Game.player.o.position.x, pz = Game.player.o.position.z;
    for (let i = 0; i < E.enemies.length; i++) {
      const en = E.enemies[i];
      const bar = en.bar;
      if (!bar || !bar.el) continue;
      if (en.state === STATES.DEAD) { bar.el.style.display = 'none'; continue; }
      const dx = en.o.position.x - px, dz = en.o.position.z - pz;
      if (dx * dx + dz * dz > 29 * 29) { bar.el.style.display = 'none'; continue; }
      en.o.getWorldPosition(tmpScreen);
      tmpScreen.y += 2.05;
      tmpScreen.project(cam);
      if (tmpScreen.z < -1 || tmpScreen.z > 1 || Math.abs(tmpScreen.x) > 1.15 || Math.abs(tmpScreen.y) > 1.15) {
        bar.el.style.display = 'none';
        continue;
      }
      const x = (tmpScreen.x * 0.5 + 0.5) * global.innerWidth;
      const y = (-tmpScreen.y * 0.5 + 0.5) * global.innerHeight;
      bar.el.style.display = 'block';
      bar.el.style.left = x + 'px';
      bar.el.style.top = y + 'px';
      bar.fill.style.transform = 'scaleX(' + U.clamp(en.hp / en.maxHp, 0, 1) + ')';
    }
  }

  function syncPlayerHUD() {
    const active = Game.mode === 'play' && !Game.settingsOpen && !!Game.player;
    if (E.els.player) E.els.player.style.display = active ? 'block' : 'none';
    if (E.els.playerNum) E.els.playerNum.textContent = Math.ceil(E.playerHealth);
    if (E.els.playerFill) E.els.playerFill.style.transform = 'scaleX(' + U.clamp(E.playerHealth / E.playerMaxHealth, 0, 1) + ')';
    if (E.els.down) E.els.down.style.display = E.playerDownTimer > 0 ? 'block' : 'none';
  }

  function updateAI(dt) {
    if (!E.spawned) spawnEnemies();
    if (!E.spawned) return;

    E.graceTimer = Math.max(0, E.graceTimer - dt);
    if (E.playerDownTimer > 0) {
      E.playerDownTimer = Math.max(0, E.playerDownTimer - dt);
      if (E.playerDownTimer === 0) respawnPlayer();
    }

    for (let i = 0; i < E.enemies.length; i++) updateEnemy(E.enemies[i], dt);
    updateEnemyBars();
    syncPlayerHUD();
  }

  E.init = function () {
    if (E.initialized) return;
    E.initialized = true;
    installStyle();
    installDOM();
    console.log('[GTA-04] enemy AI ready');
  };

  E.damagePlayer = damagePlayer;
  E.getLiving = function () {
    return E.enemies.filter(function (x) { return x.state !== STATES.DEAD; });
  };

  const originalInit = Game.init;
  Game.init = function () {
    const out = originalInit.apply(Game, arguments);
    E.init();
    return out;
  };

  const originalUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!E.initialized) E.init();
    const out = originalUpdate.call(Game, dt, elapsed);
    if (Game.mode === 'play' && !Game.settingsOpen && Game.player) updateAI(dt);
    else {
      syncPlayerHUD();
      for (let i = 0; i < E.enemies.length; i++) {
        if (E.enemies[i].bar && E.enemies[i].bar.el) E.enemies[i].bar.el.style.display = 'none';
      }
    }
    return out;
  };
})(window);
