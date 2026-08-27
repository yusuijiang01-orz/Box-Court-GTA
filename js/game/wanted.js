/* =============================================================
   js/game/wanted.js — GTA-06 basic wanted / police pursuit v1

   GTA-06 scope:
   - crimes create heat and 1..5 wanted stars;
   - independent police pool, pursuit and melee pressure;
   - building-aware line of sight so cover can break visual contact;
   - escape countdown while unseen / far away;
   - one-star-at-a-time decay until wanted clears;
   - civilian / police hits are crimes; GTA-04/GTA-05 hostiles are not.

   No police cars, roadblocks, helicopters, SWAT, firearms or arrest system.
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
  const EnemyAI = TOWN.EnemyAI;

  const POLICE_STATES = Object.freeze({
    CHASE: 'CHASE',
    SEARCH: 'SEARCH',
    ATTACK: 'ATTACK',
    RETREAT: 'RETREAT',
    DEAD: 'DEAD',
  });

  const STAR_MIN = [0, 1, 25, 45, 65, 85];
  const POLICE_BY_STAR = [0, 1, 2, 3, 4, 6];
  const ESCAPE_BY_STAR = [0, 8, 10, 12, 14, 16];
  const POLICE_MAX_HP = 100;
  const PISTOL_DAMAGE = 34;
  const POLICE_RADIUS = 0.40;
  const ATTACK_RANGE = 1.62;

  const W = TOWN.Wanted = {
    version: 'GTA-06.1',
    initialized: false,
    heat: 0,
    stars: 0,
    seen: false,
    escapeTimer: 0,
    crimePulse: 0,
    lastKnown: new T.Vector3(),
    police: [],
    spawnSerial: 0,
    els: {},
    POLICE_STATES: POLICE_STATES,
  };
  TOWN.PoliceAI = W;

  const tmpTarget = new T.Vector3();

  const policeBlue = new T.MeshStandardMaterial({
    color: 0x203b62, roughness: 0.72, metalness: 0.04
  });
  const policeDark = new T.MeshStandardMaterial({
    color: 0x111923, roughness: 0.76, metalness: 0.08
  });
  const badgeMat = new T.MeshStandardMaterial({
    color: 0xd6b85c, roughness: 0.36, metalness: 0.55
  });

  function isDriving() {
    return !!(Vehicles && Vehicles.STATES &&
      Vehicles.state === Vehicles.STATES.DRIVING &&
      Vehicles.current && Vehicles.current.car);
  }

  function playerTarget(out) {
    out = out || tmpTarget;
    if (isDriving()) return out.copy(Vehicles.current.car.position);
    if (Game.player && Game.player.o) return out.copy(Game.player.o.position);
    return out.set(0, 0, 0);
  }

  function sampleGround(x, z) {
    if (C && C.sample) return C.sample(x, z);
    return Island && Island.sample ? Island.sample(x, z) : { y: 0, land: true };
  }

  function pointBlocked(x, z, radius) {
    const solids = C && C.solids ? C.solids : (TOWN.Colliders || []);
    const r = radius || 0;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (!s || !isFinite(s.x) || !isFinite(s.z)) continue;
      const w = s.w || 0, d = s.d || 0;
      const dx = x - s.x, dz = z - s.z;
      const rr = (s.r || Math.hypot(w, d) * 0.5) + r;
      if (dx * dx + dz * dz > rr * rr) continue;
      const co = Math.cos(s.rot || 0), si = Math.sin(s.rot || 0);
      const lx = co * dx - si * dz;
      const lz = si * dx + co * dz;
      if (Math.abs(lx) < w * 0.5 + r &&
          Math.abs(lz) < d * 0.5 + r) return true;
    }
    return false;
  }

  function validStep(x, z, fromY) {
    if (pointBlocked(x, z, POLICE_RADIUS)) return null;
    const s = sampleGround(x, z);
    if (!s || !s.land || !isFinite(s.y)) return null;
    if (isFinite(fromY) && Math.abs(s.y - fromY) > 0.58) return null;
    return s;
  }

  // 2-D segment-vs-OBB test. Collision solids represent building / structure
  // footprints; this makes "hide behind a building" meaningful without a
  // whole-scene Mesh raycast.
  function segmentBlocked(ax, az, bx, bz) {
    const solids = C && C.solids ? C.solids : (TOWN.Colliders || []);
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (!s || !isFinite(s.x) || !isFinite(s.z) || !isFinite(s.w) || !isFinite(s.d)) continue;
      const co = Math.cos(s.rot || 0), si = Math.sin(s.rot || 0);
      const adx = ax - s.x, adz = az - s.z;
      const bdx = bx - s.x, bdz = bz - s.z;
      const x0 = co * adx - si * adz;
      const z0 = si * adx + co * adz;
      const x1 = co * bdx - si * bdz;
      const z1 = si * bdx + co * bdz;
      const vx = x1 - x0, vz = z1 - z0;
      const hw = s.w * 0.5 + 0.06, hd = s.d * 0.5 + 0.06;
      let t0 = 0, t1 = 1;

      if (Math.abs(vx) < 1e-8) {
        if (x0 < -hw || x0 > hw) continue;
      } else {
        let a = (-hw - x0) / vx, b = (hw - x0) / vx;
        if (a > b) { const q = a; a = b; b = q; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }

      if (Math.abs(vz) < 1e-8) {
        if (z0 < -hd || z0 > hd) continue;
      } else {
        let a = (-hd - z0) / vz, b = (hd - z0) / vz;
        if (a > b) { const q = a; a = b; b = q; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }

      // Ignore an intersection exactly at an endpoint so a cop standing near
      // a wall does not consider the wall containing its own shoulder.
      if (t1 > 0.025 && t0 < 0.975) return true;
    }
    return false;
  }

  function starsForHeat(heat) {
    if (heat < STAR_MIN[1]) return 0;
    if (heat < STAR_MIN[2]) return 1;
    if (heat < STAR_MIN[3]) return 2;
    if (heat < STAR_MIN[4]) return 3;
    if (heat < STAR_MIN[5]) return 4;
    return 5;
  }

  function escapeDuration(stars) {
    return ESCAPE_BY_STAR[U.clamp(stars | 0, 0, 5)] || 0;
  }

  function updateStars(resetTimer) {
    const old = W.stars;
    W.stars = starsForHeat(W.heat);
    if (W.stars > 0 && (resetTimer || W.stars !== old)) {
      W.escapeTimer = escapeDuration(W.stars);
    }
    if (W.stars === 0) {
      W.heat = 0;
      W.escapeTimer = 0;
      W.seen = false;
      W.crimePulse = 0;
    }
  }

  function installStyle() {
    if (document.getElementById('gta06-style')) return;
    const s = document.createElement('style');
    s.id = 'gta06-style';
    s.textContent = [
      '#gta06-wanted{position:fixed;right:15px;top:16px;z-index:172;min-width:170px;text-align:right;',
      'padding:8px 10px;border-radius:8px;background:rgba(6,8,11,.67);border:1px solid rgba(255,255,255,.13);',
      'color:#fff;font-family:system-ui,-apple-system,sans-serif;display:none;pointer-events:none;text-shadow:0 1px 2px #000}',
      '#gta06-stars{font:900 21px/1 ui-monospace,monospace;letter-spacing:2px;white-space:nowrap}',
      '#gta06-stars span{color:rgba(255,255,255,.24)}#gta06-stars span.on{color:#ffd35a;text-shadow:0 0 6px rgba(255,196,46,.42)}',
      '#gta06-search{margin-top:5px;font:700 10px/1.1 system-ui,-apple-system,sans-serif;letter-spacing:.06em;color:rgba(255,255,255,.78)}',
      '#gta06-search.hot{color:#ff7c66}#gta06-search.escape{color:#9fd8ff}',
      '@media(max-width:700px){#gta06-wanted{right:8px;top:8px;min-width:142px;padding:6px 8px}#gta06-stars{font-size:18px;letter-spacing:1px}}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (W.els.root) return;
    const root = document.createElement('div');
    root.id = 'gta06-wanted';
    root.innerHTML = '<div id="gta06-stars"></div><div id="gta06-search"></div>';
    document.body.appendChild(root);
    W.els.root = root;
    W.els.stars = root.querySelector('#gta06-stars');
    W.els.search = root.querySelector('#gta06-search');
  }

  function syncHUD() {
    if (!W.els.root) return;
    const active = W.stars > 0 && Game.mode === 'play' && !Game.settingsOpen;
    W.els.root.style.display = active ? 'block' : 'none';
    if (!active) return;

    let html = '';
    for (let i = 0; i < 5; i++) html += '<span class="' + (i < W.stars ? 'on' : '') + '">★</span>';
    W.els.stars.innerHTML = html;

    if (W.seen || W.crimePulse > 0.01) {
      W.els.search.className = 'hot';
      W.els.search.textContent = '追捕中 · ' + W.stars + ' 星';
    } else {
      W.els.search.className = 'escape';
      W.els.search.textContent = '脱离搜捕 ' + Math.max(0, W.escapeTimer).toFixed(1) + 's';
    }
  }

  function addPoliceVisual(o) {
    const vest = new T.Mesh(new T.BoxGeometry(0.48, 0.58, 0.29), policeBlue);
    vest.position.set(0, 1.08, 0.01);
    o.add(vest);

    const belt = new T.Mesh(new T.BoxGeometry(0.48, 0.08, 0.31), policeDark);
    belt.position.set(0, 0.78, 0.01);
    o.add(belt);

    const cap = new T.Mesh(new T.CylinderGeometry(0.19, 0.21, 0.11, 10), policeBlue);
    cap.position.set(0, 1.79, 0);
    o.add(cap);

    const badge = new T.Mesh(new T.BoxGeometry(0.07, 0.09, 0.025), badgeMat);
    badge.position.set(0.12, 1.20, 0.16);
    o.add(badge);

    o.traverse(function (x) {
      if (x.isMesh) { x.castShadow = false; x.receiveShadow = false; }
    });
  }

  function captureLimbBases(limbs) {
    const out = [];
    for (let i = 0; i < (limbs ? limbs.length : 0); i++) {
      const l = limbs[i];
      out.push(l ? { x: l.rotation.x, y: l.rotation.y, z: l.rotation.z } : null);
    }
    return out;
  }

  function ensureNPC(o) {
    if (!Game.npcs) Game.npcs = [];
    if (Game.npcs.indexOf(o) < 0) Game.npcs.push(o);
  }

  function removeNPC(o) {
    const list = Game.npcs || [];
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1);
  }

  function findPoliceSpawn() {
    const t = playerTarget(tmpTarget);
    const radii = [18, 21, 24, 27, 30];
    const seed = ++W.spawnSerial;
    const base = U.mod(seed * 2.3999632297 + W.stars * 0.61, Math.PI * 2);

    for (let ri = 0; ri < radii.length; ri++) {
      for (let ai = 0; ai < 10; ai++) {
        const a = base + ai * (Math.PI * 2 / 10);
        const r = radii[ri];
        const x = t.x + Math.cos(a) * r;
        const z = t.z + Math.sin(a) * r;
        const s = validStep(x, z, NaN);
        if (!s) continue;

        let clear = true;
        for (let i = 0; i < W.police.length; i++) {
          const p = W.police[i];
          if (!p || !p.o || p.state === POLICE_STATES.DEAD) continue;
          const dx = p.o.position.x - x, dz = p.o.position.z - z;
          if (dx * dx + dz * dz < 6.25) { clear = false; break; }
        }
        if (clear) return { x: x, y: s.y, z: z };
      }
    }

    const x = t.x + 16 + (seed % 3) * 2;
    const z = t.z + 14;
    const s = sampleGround(x, z);
    return s && s.land ? { x: x, y: s.y, z: z } : null;
  }

  function spawnPolice() {
    if (!Game.player || !TOWN.Stage || !TOWN.Stage.scene) return null;
    const pos = findPoliceSpawn();
    if (!pos) return null;

    const built = Dyn.buildPerson(U.rng(606000 + W.spawnSerial * 313), 1.02, false);
    const o = built.o;
    o.position.set(pos.x, pos.y, pos.z);
    o.rotation.y = W.spawnSerial * 0.83;
    o.name = 'gta06-police-' + W.spawnSerial;
    o.userData.kind = 'pedestrian';
    o.userData.gta06Police = true;
    o.userData.gta06Dead = false;
    o.userData.gta03Hits = 0;
    o.userData.name = '警察';
    o.userData.line = '站住！';
    o.userData.npcId = 6000 + W.spawnSerial;
    o.userData.limbs = built.limbs;
    o.userData.torso = built.torso;
    addPoliceVisual(o);
    TOWN.markDynamic(o);
    TOWN.Stage.scene.add(o);
    ensureNPC(o);

    const p = {
      o: o,
      limbs: built.limbs,
      limbBase: captureLimbBases(built.limbs),
      hp: POLICE_MAX_HP,
      lastGunHits: 0,
      state: POLICE_STATES.CHASE,
      walkPhase: W.spawnSerial * 0.9,
      attackCooldown: 0.4 + (W.spawnSerial % 4) * 0.14,
      swingTimer: 0,
      swingHit: false,
      hurtTimer: 0,
      deadTimer: 0,
    };
    W.police.push(p);
    return p;
  }

  function activePolice() {
    const out = [];
    for (let i = 0; i < W.police.length; i++) {
      const p = W.police[i];
      if (!p || !p.o || p.state === POLICE_STATES.DEAD || p.state === POLICE_STATES.RETREAT) continue;
      out.push(p);
    }
    return out;
  }

  function policeDistance(p, target) {
    const dx = p.o.position.x - target.x;
    const dz = p.o.position.z - target.z;
    return Math.hypot(dx, dz);
  }

  function setRetreatExcess() {
    const desired = POLICE_BY_STAR[W.stars] || 0;
    const t = playerTarget(tmpTarget);
    const list = activePolice();
    list.sort(function (a, b) { return policeDistance(a, t) - policeDistance(b, t); });
    for (let i = desired; i < list.length; i++) list[i].state = POLICE_STATES.RETREAT;
  }

  function ensurePoliceCount() {
    if (W.stars <= 0) return;
    setRetreatExcess();
    const desired = POLICE_BY_STAR[W.stars] || 0;
    const n = activePolice().length;
    if (n >= desired) return;
    if (!W.seen && W.crimePulse <= 0) return;

    // At most one spawn per frame. This keeps sudden star jumps from creating
    // several people on exactly the same render frame.
    spawnPolice();
  }

  function policeSees(p, target) {
    if (!p || !p.o || p.state === POLICE_STATES.DEAD || p.state === POLICE_STATES.RETREAT) return false;
    const dx = target.x - p.o.position.x;
    const dz = target.z - p.o.position.z;
    const range = 25 + W.stars * 2.0;
    if (dx * dx + dz * dz > range * range) return false;
    return !segmentBlocked(p.o.position.x, p.o.position.z, target.x, target.z);
  }

  function restoreLimb(p, i) {
    const l = p.limbs && p.limbs[i];
    const b = p.limbBase && p.limbBase[i];
    if (!l || !b) return;
    l.rotation.x = b.x; l.rotation.y = b.y; l.rotation.z = b.z;
  }

  function animatePolice(p, dt, moving) {
    const limbs = p.limbs || [];
    if (p.state === POLICE_STATES.DEAD) {
      for (let i = 0; i < limbs.length; i++) restoreLimb(p, i);
      p.o.rotation.z += (1.34 - p.o.rotation.z) * Math.min(1, dt * 8);
      return;
    }

    p.o.rotation.z *= Math.max(0, 1 - dt * 12);
    if (moving) {
      const speed = 3.0 + W.stars * 0.28;
      p.walkPhase += dt * speed * 5.2;
      const sw = Math.sin(p.walkPhase) * 0.62;
      if (limbs[0] && p.limbBase[0]) limbs[0].rotation.x = p.limbBase[0].x + sw;
      if (limbs[1] && p.limbBase[1]) limbs[1].rotation.x = p.limbBase[1].x - sw;
      if (limbs[2] && p.limbBase[2]) limbs[2].rotation.x = p.limbBase[2].x - sw * 0.75;
      if (limbs[3] && p.limbBase[3]) limbs[3].rotation.x = p.limbBase[3].x + sw * 0.75;
    } else {
      for (let i = 0; i < limbs.length; i++) {
        const l = limbs[i], b = p.limbBase[i];
        if (!l || !b) continue;
        l.rotation.x += (b.x - l.rotation.x) * Math.min(1, dt * 9);
        l.rotation.y += (b.y - l.rotation.y) * Math.min(1, dt * 9);
        l.rotation.z += (b.z - l.rotation.z) * Math.min(1, dt * 9);
      }
    }

    if (p.swingTimer > 0 && limbs[3]) {
      const q = 1 - p.swingTimer / 0.46;
      const punch = Math.sin(U.clamp(q, 0, 1) * Math.PI);
      const b = p.limbBase[3];
      limbs[3].rotation.x = (b ? b.x : 0) - 1.18 * punch;
      limbs[3].rotation.z = (b ? b.z : 0) - 0.16 * punch;
    }
    if (p.hurtTimer > 0) p.o.rotation.z -= Math.sin((p.hurtTimer / 0.22) * Math.PI) * 0.12;
  }

  function facePoint(p, x, z, dt) {
    const dx = x - p.o.position.x, dz = z - p.o.position.z;
    const target = Math.atan2(dx, dz);
    const diff = U.mod(target - p.o.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    p.o.rotation.y += diff * Math.min(1, dt * 9);
  }

  function tryMove(p, tx, tz, dt, away) {
    const o = p.o;
    let dx = tx - o.position.x, dz = tz - o.position.z;
    if (away) { dx = -dx; dz = -dz; }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const speed = (away ? 3.35 : 3.0 + W.stars * 0.28);
    const step = speed * dt;
    const base = Math.atan2(dz, dx);
    const turns = [0, 0.52, -0.52, 0.95, -0.95];

    for (let i = 0; i < turns.length; i++) {
      const a = base + turns[i];
      const vx = Math.cos(a), vz = Math.sin(a);
      const nx = o.position.x + vx * step;
      const nz = o.position.z + vz * step;
      const s = validStep(nx, nz, o.position.y);
      if (!s) continue;
      o.position.set(nx, s.y, nz);
      return true;
    }
    return false;
  }

  function damagePlayer(amount) {
    if (EnemyAI && EnemyAI.damagePlayer) EnemyAI.damagePlayer(amount);
  }

  function killPolice(p) {
    if (!p || p.state === POLICE_STATES.DEAD) return;
    p.hp = 0;
    p.state = POLICE_STATES.DEAD;
    p.o.userData.gta06Dead = true;
    p.o.userData.gta06Health = 0;
    p.deadTimer = 5.0;
    removeNPC(p.o);
    W.addHeat(26, 'policeKilled');
  }

  function consumeGunHits(p) {
    if (!p || p.state === POLICE_STATES.DEAD) return;
    const hits = p.o.userData.gta03Hits | 0;
    if (hits <= p.lastGunHits) return;
    const delta = hits - p.lastGunHits;
    p.lastGunHits = hits;
    p.hp = Math.max(0, p.hp - delta * PISTOL_DAMAGE);
    p.o.userData.gta06Health = p.hp;
    p.hurtTimer = 0.22;
    if (p.hp <= 0) killPolice(p);
  }

  function updateDeadPolice(p, dt) {
    p.deadTimer -= dt;
    animatePolice(p, dt, false);
    if (p.deadTimer <= 0 && p.o && p.o.parent) {
      p.o.parent.remove(p.o);
      p.o.visible = false;
    }
  }

  function updatePolice(p, dt, target) {
    consumeGunHits(p);
    if (p.state === POLICE_STATES.DEAD) {
      updateDeadPolice(p, dt);
      return;
    }

    p.hurtTimer = Math.max(0, p.hurtTimer - dt);
    p.attackCooldown = Math.max(0, p.attackCooldown - dt);
    if (p.swingTimer > 0) {
      const before = p.swingTimer;
      p.swingTimer = Math.max(0, p.swingTimer - dt);
      if (!p.swingHit && before > 0.24 && p.swingTimer <= 0.24) {
        p.swingHit = true;
        if (!isDriving()) {
          const dx = target.x - p.o.position.x;
          const dz = target.z - p.o.position.z;
          if (dx * dx + dz * dz <= 1.92 * 1.92) damagePlayer(8 + W.stars);
        }
      }
    }

    if (p.state === POLICE_STATES.RETREAT || W.stars === 0) {
      p.state = POLICE_STATES.RETREAT;
      facePoint(p, target.x, target.z, dt);
      const moved = tryMove(p, target.x, target.z, dt, true);
      animatePolice(p, dt, moved);
      if (policeDistance(p, target) > 24) {
        removeNPC(p.o);
        if (p.o.parent) p.o.parent.remove(p.o);
        p.o.visible = false;
      }
      return;
    }

    const sees = policeSees(p, target);
    const goal = sees ? target : W.lastKnown;
    const dx = goal.x - p.o.position.x;
    const dz = goal.z - p.o.position.z;
    const distGoal = Math.hypot(dx, dz);
    const distPlayer = policeDistance(p, target);

    if (sees && !isDriving() && distPlayer <= ATTACK_RANGE) {
      p.state = POLICE_STATES.ATTACK;
      facePoint(p, target.x, target.z, dt);
      if (p.attackCooldown <= 0 && p.swingTimer <= 0) {
        p.swingTimer = 0.46;
        p.swingHit = false;
        p.attackCooldown = Math.max(0.68, 1.05 - W.stars * 0.05);
      }
      animatePolice(p, dt, false);
      return;
    }

    if (!sees && distGoal < 1.5) {
      p.state = POLICE_STATES.SEARCH;
      p.o.rotation.y += dt * (0.55 + (p.o.userData.npcId % 3) * 0.12);
      animatePolice(p, dt, false);
      return;
    }

    p.state = POLICE_STATES.CHASE;
    facePoint(p, goal.x, goal.z, dt);
    const moved = tryMove(p, goal.x, goal.z, dt, false);
    animatePolice(p, dt, moved);
  }

  function evaluateSight(target) {
    let any = false;
    const list = activePolice();
    for (let i = 0; i < list.length; i++) {
      if (policeSees(list[i], target)) { any = true; break; }
    }
    W.seen = any;
    if (any) {
      W.lastKnown.copy(target);
      W.escapeTimer = escapeDuration(W.stars);
    }
  }

  function dropOneStar() {
    const old = W.stars;
    if (old <= 0) return;
    W.heat = old <= 1 ? 0 : STAR_MIN[old - 1];
    updateStars(true);
    setRetreatExcess();
  }

  function updateEscape(dt) {
    if (W.stars <= 0) return;
    if (W.seen || W.crimePulse > 0) {
      W.escapeTimer = escapeDuration(W.stars);
      return;
    }
    W.escapeTimer = Math.max(0, W.escapeTimer - dt);
    if (W.escapeTimer <= 0) dropOneStar();
  }

  function cleanupPoliceArray() {
    for (let i = W.police.length - 1; i >= 0; i--) {
      const p = W.police[i];
      if (!p || !p.o) { W.police.splice(i, 1); continue; }
      if (!p.o.visible && !p.o.parent) W.police.splice(i, 1);
    }
  }

  function hardClearPolice() {
    for (let i = 0; i < W.police.length; i++) {
      const p = W.police[i];
      if (!p || !p.o) continue;
      removeNPC(p.o);
      if (p.o.parent) p.o.parent.remove(p.o);
      p.o.visible = false;
    }
    W.police.length = 0;
  }

  function isHostileNPC(npc) {
    return !!(npc && npc.userData &&
      (npc.userData.gta04Enemy || npc.userData.gta05Target));
  }

  function handleNPCHit(payload) {
    const npc = payload && payload.npc;
    if (!npc || !npc.userData || isHostileNPC(npc)) return;
    if (npc.userData.gta06Police) W.addHeat(18, 'policeHit');
    else W.addHeat(16, 'civilianHit');
  }

  W.addHeat = function (amount, reason) {
    amount = Math.max(0, Number(amount) || 0);
    if (amount <= 0) return W.stars;
    W.heat = U.clamp(W.heat + amount, 0, 100);
    W.crimePulse = 4.0;
    playerTarget(W.lastKnown);
    updateStars(true);
    console.log('[GTA-06] crime:', reason || 'crime', 'heat=' + W.heat, 'stars=' + W.stars);
    return W.stars;
  };

  W.reportCrime = function (type, amount) {
    return W.addHeat(amount === undefined ? 16 : amount, type || 'crime');
  };

  W.clear = function (hard) {
    W.heat = 0;
    W.stars = 0;
    W.seen = false;
    W.escapeTimer = 0;
    W.crimePulse = 0;
    if (hard) hardClearPolice();
    else setRetreatExcess();
    syncHUD();
  };

  function installCrimeBridge() {
    if (!Missions || !Missions.emit || Missions.emit.__gta06Wrapped) return;
    const baseEmit = Missions.emit;
    const wrapped = function (eventName, payload) {
      if (eventName === 'npcHit') handleNPCHit(payload);
      return baseEmit.apply(Missions, arguments);
    };
    wrapped.__gta06Wrapped = true;
    Missions.emit = wrapped;
  }

  function updateWanted(dt) {
    if (W.stars <= 0) {
      W.seen = false;
      setRetreatExcess();
      const target0 = playerTarget(tmpTarget);
      for (let i = 0; i < W.police.length; i++) updatePolice(W.police[i], dt, target0);
      cleanupPoliceArray();
      syncHUD();
      return;
    }

    // GTA-style reset on player defeat. GTA-04 owns the down/respawn sequence.
    if (EnemyAI && EnemyAI.playerDownTimer > 0) {
      W.clear(true);
      return;
    }

    W.crimePulse = Math.max(0, W.crimePulse - dt);
    const target = playerTarget(tmpTarget);

    // Existing units establish contact first; a new crime can still spawn the
    // first unit through crimePulse even when no officer is currently present.
    evaluateSight(target);
    ensurePoliceCount();

    // A just-spawned officer may immediately have visual contact.
    evaluateSight(target);

    for (let i = 0; i < W.police.length; i++) updatePolice(W.police[i], dt, target);

    // Movement can change line-of-sight; use the post-move result for escape.
    evaluateSight(target);
    updateEscape(dt);
    setRetreatExcess();
    cleanupPoliceArray();
    syncHUD();
  }

  W.init = function () {
    if (W.initialized) return;
    W.initialized = true;
    installStyle();
    installDOM();
    installCrimeBridge();
    console.log('[GTA-06] wanted / police system ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    W.init();
    return out;
  };

  const baseUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!W.initialized) W.init();
    installCrimeBridge();
    const out = baseUpdate.call(Game, dt, elapsed);
    if (Game.mode === 'play' && !Game.settingsOpen && Game.player) updateWanted(dt);
    else syncHUD();
    return out;
  };
})(window);
