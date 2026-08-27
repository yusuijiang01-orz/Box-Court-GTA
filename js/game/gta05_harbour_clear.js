/* =============================================================
   js/game/gta05_harbour_clear.js — GTA-05 first complete mission

   Mission: 码头清场
   Flow:
     start -> enter vehicle -> drive to harbour -> exit vehicle
     -> eliminate 3 hostile targets -> reward +$500

   This is a thin orchestration layer. It reuses GTA-01 Missions,
   GTA-02 vehicle events, GTA-03 weapon hit counters and GTA-04 enemies.
   No police, wanted system, shops or new combat mechanics live here.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game || !TOWN.Missions) return;

  const Game = TOWN.Game;
  const Missions = TOWN.Missions;
  const EnemyAI = TOWN.EnemyAI;
  const Collision = TOWN.CollisionV1;
  const Island = TOWN.Island;

  const MISSION_ID = 'gta05-harbour-clear';
  const LEGACY_ID = 'gta01-harbour-run';
  const REWARD = 500;
  const HARBOUR = { x: 12, z: 20 };

  const G = TOWN.GTA05 = {
    version: 'GTA-05.1',
    missionId: MISSION_ID,
    reward: REWARD,
    setup: false,
    combatActive: false,
    rewardGranted: false,
    killCount: 0,
    killed: Object.create(null),
    targets: [],
  };

  function distanceXZ(a, b) {
    if (!a || !b) return Infinity;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  function surfaceAt(x, z) {
    if (Collision && Collision.sample) return Collision.sample(x, z);
    if (Island && Island.sample) return Island.sample(x, z);
    return { y: 0, land: true };
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
  }

  function placeStartMarker() {
    const marker = Missions.startMarker;
    if (!marker) return;
    const m = Missions.get(MISSION_ID);
    if (!m || !m.start) return;
    const s = surfaceAt(m.start.x, m.start.z);
    marker.position.set(m.start.x, (s && isFinite(s.y) ? s.y : 0) + 0.03, m.start.z);
  }

  function pointBlocked(x, z, radius) {
    if (!Collision || !Collision.solids) return false;
    const solids = Collision.solids;
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
      if (Math.abs(lx) <= (s.w || 0) * 0.5 + r &&
          Math.abs(lz) <= (s.d || 0) * 0.5 + r) return true;
    }
    return false;
  }

  function validCombatSpot(x, z) {
    if (pointBlocked(x, z, 0.48)) return null;
    const s = surfaceAt(x, z);
    if (!s || !s.land || !isFinite(s.y)) return null;
    return { x: x, y: s.y, z: z };
  }

  function findCombatSpot(index, used) {
    const candidates = [
      [7.0, 18.0], [14.8, 18.0], [20.0, 18.5],
      [8.5, 21.0], [16.5, 21.0], [5.0, 16.5], [18.5, 15.5]
    ];
    for (let pass = 0; pass < candidates.length; pass++) {
      const c = candidates[(index + pass) % candidates.length];
      const offsets = [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]];
      for (let oi = 0; oi < offsets.length; oi++) {
        const x = c[0] + offsets[oi][0];
        const z = c[1] + offsets[oi][1];
        const p = validCombatSpot(x, z);
        if (!p) continue;
        let clear = true;
        for (let k = 0; k < used.length; k++) {
          if (distanceXZ(p, used[k]) < 3.0) { clear = false; break; }
        }
        if (clear) return p;
      }
    }
    const fallback = validCombatSpot(HARBOUR.x + (index - 1) * 3.2, HARBOUR.z - 3.0);
    return fallback || { x: HARBOUR.x + index * 2.5, y: surfaceAt(HARBOUR.x, HARBOUR.z).y || 0, z: HARBOUR.z };
  }

  function ensureNPCRegistered(o) {
    if (!o) return;
    if (!Game.npcs) Game.npcs = [];
    if (Game.npcs.indexOf(o) < 0) Game.npcs.push(o);
  }

  function hideEnemy(enemy) {
    if (!enemy) return;
    enemy.aggro = false;
    if (EnemyAI && EnemyAI.STATES && enemy.state !== EnemyAI.STATES.DEAD) {
      enemy.state = EnemyAI.STATES.IDLE;
    }
    if (enemy.o) {
      enemy.o.visible = false;
      enemy.o.userData.gta05Target = false;
    }
    if (enemy.bar && enemy.bar.el) enemy.bar.el.style.display = 'none';
  }

  function suppressEnemyPool() {
    if (!EnemyAI || !EnemyAI.spawned || G.combatActive) return;
    EnemyAI.graceTimer = Math.max(EnemyAI.graceTimer || 0, 9999);
    const enemies = EnemyAI.enemies || [];
    for (let i = 0; i < enemies.length; i++) hideEnemy(enemies[i]);
  }

  function resetTarget(enemy, index, pos) {
    if (!enemy || !enemy.o || !EnemyAI || !EnemyAI.STATES) return;
    enemy.o.visible = true;
    enemy.o.position.set(pos.x, pos.y, pos.z);
    enemy.o.rotation.x = 0;
    enemy.o.rotation.z = 0;
    enemy.o.userData.gta05Target = true;
    enemy.o.userData.gta04Dead = false;
    enemy.o.userData.gta04Health = 100;
    enemy.o.userData.gta03Hits = 0;
    enemy.o.userData.name = '码头敌人' + (index + 1);
    enemy.hp = 100;
    enemy.maxHp = 100;
    enemy.lastGunHits = 0;
    enemy.hurtTimer = 0;
    enemy.swingTimer = 0;
    enemy.swingHit = false;
    enemy.attackCooldown = 0.45 + index * 0.18;
    enemy.aggro = true;
    enemy.state = EnemyAI.STATES.CHASE;
    ensureNPCRegistered(enemy.o);
  }

  function activateCombat() {
    if (G.combatActive || !EnemyAI || !EnemyAI.spawned) return false;
    const enemies = EnemyAI.enemies || [];
    if (enemies.length < 3) return false;

    G.combatActive = true;
    G.targets.length = 0;
    EnemyAI.graceTimer = 0;

    const used = [];
    for (let i = 0; i < enemies.length; i++) {
      if (i < 3) {
        const pos = findCombatSpot(i, used);
        used.push(pos);
        resetTarget(enemies[i], i, pos);
        G.targets.push(enemies[i]);
      } else {
        hideEnemy(enemies[i]);
      }
    }
    console.log('[GTA-05] harbour combat activated:', G.targets.length);
    return true;
  }

  function resetMissionRuntime() {
    G.combatActive = false;
    G.rewardGranted = false;
    G.killCount = 0;
    G.killed = Object.create(null);
    G.targets.length = 0;
    const m = Missions.get(MISSION_ID);
    if (m && m.objectives && m.objectives[3]) {
      m.objectives[3].label = '消灭敌人 0 / 3';
    }
    suppressEnemyPool();
  }

  function grantReward() {
    if (G.rewardGranted) return;
    G.rewardGranted = true;
    if (!TOWN.Economy) TOWN.Economy = { money: 0 };
    if (!isFinite(TOWN.Economy.money)) TOWN.Economy.money = 0;
    TOWN.Economy.money += REWARD;
    console.log('[GTA-05] reward +$' + REWARD + ', total $' + TOWN.Economy.money);
  }

  function vehicleAtHarbour(payload, objective) {
    if (!payload || !payload.position || !objective || !objective.position) return false;
    return distanceXZ(payload.position, objective.position) <= (objective.radius || 7);
  }

  function countTargetKill(payload, objective) {
    const enemy = payload && payload.enemy;
    if (!enemy || !enemy.userData || !enemy.userData.gta05Target) return false;
    const key = String(payload.enemyId === undefined ? enemy.uuid : payload.enemyId);
    if (!G.killed[key]) {
      G.killed[key] = true;
      G.killCount++;
    }
    objective.label = '消灭敌人 ' + Math.min(3, G.killCount) + ' / 3';
    return G.killCount >= 3;
  }

  const DEFINITION = {
    id: MISSION_ID,
    title: '码头清场',
    start: { x: 4, z: -6, radius: 3.2 },
    objectives: [
      {
        id: 'get-vehicle',
        type: 'event',
        event: 'vehicleEntered',
        label: '找到一辆车并上车',
      },
      {
        id: 'drive-harbour',
        type: 'event',
        event: 'reachDestination',
        label: '驾车前往码头',
        position: { x: HARBOUR.x, z: HARBOUR.z },
        radius: 7.0,
        test: vehicleAtHarbour,
      },
      {
        id: 'exit-at-harbour',
        type: 'event',
        event: 'vehicleExited',
        label: '到达码头后下车',
        position: { x: HARBOUR.x, z: HARBOUR.z },
        radius: 10.0,
        test: vehicleAtHarbour,
      },
      {
        id: 'clear-hostiles',
        type: 'event',
        event: 'enemyKilled',
        label: '消灭敌人 0 / 3',
        test: countTargetKill,
      },
    ],
  };

  function ensureSetup() {
    if (G.setup || !Missions.initialized) return;

    const legacy = Missions.get(LEGACY_ID);
    if (legacy && legacy.state !== Missions.STATES.ACTIVE) legacy.state = Missions.STATES.LOCKED;

    if (!Missions.get(MISSION_ID)) Missions.register(DEFINITION);
    placeStartMarker();
    G.setup = true;
    console.log('[GTA-05] harbour clear mission ready');
  }

  const baseStart = Missions.start;
  Missions.start = function (id) {
    if (id === MISSION_ID) resetMissionRuntime();
    const out = baseStart.apply(Missions, arguments);
    if (out && id === MISSION_ID) {
      if (Missions.els.toast) Missions.els.toast.innerHTML = '任务完成<small>码头清场 · 奖励 +$' + REWARD + '</small>';
    }
    return out;
  };

  const baseCompleteObjective = Missions.completeObjective;
  Missions.completeObjective = function () {
    const mission = Missions.current;
    const isOurs = !!(mission && mission.id === MISSION_ID);
    const finishing = isOurs && mission.objectiveIndex === mission.objectives.length - 1;

    if (finishing && Missions.els.toast) {
      Missions.els.toast.innerHTML = '任务完成<small>码头清场 · 奖励 +$' + REWARD + '</small>';
    }

    const out = baseCompleteObjective.apply(Missions, arguments);
    if (!out || !isOurs) return out;

    if (finishing) {
      grantReward();
      G.combatActive = false;
    } else {
      const next = Missions.getObjective();
      if (next && next.id === 'clear-hostiles') activateCombat();
    }
    return out;
  };

  const basePreUpdate = Missions.preUpdate;
  Missions.preUpdate = function (game, dt, elapsed) {
    basePreUpdate.call(Missions, game, dt, elapsed);
    ensureSetup();
    if (!G.setup) return;

    const inPlay = game && game.mode === 'play' && !game.settingsOpen && game.player;
    if (!inPlay) return;

    const mission = Missions.get(MISSION_ID);
    if (!mission) return;

    if (mission.state === Missions.STATES.AVAILABLE && !Missions.current) {
      placeStartMarker();
      if (Missions.startMarker) Missions.startMarker.visible = true;
      const near = distanceXZ(game.player.o.position, mission.start) <= mission.start.radius;
      if (Missions.els.prompt) {
        Missions.els.prompt.innerHTML = '<b>E / 交互</b>　开始任务：码头清场';
        setHidden(Missions.els.prompt, !near);
      }
      const input = game.input && game.input.state;
      if (near && input && input.interactPressed) {
        Missions.start(MISSION_ID);
        if (game.input && game.input.consume) game.input.consume('interactPressed');
      }
    } else if (Missions.current && Missions.current.id === MISSION_ID) {
      if (Missions.startMarker) Missions.startMarker.visible = false;
      setHidden(Missions.els.prompt, true);
      const objective = Missions.getObjective();
      if (objective && objective.id === 'clear-hostiles') {
        objective.label = '消灭敌人 ' + Math.min(3, G.killCount) + ' / 3';
      }
    }
  };

  const baseGameInit = Game.init;
  Game.init = function () {
    const out = baseGameInit.apply(Game, arguments);
    ensureSetup();
    return out;
  };

  const baseGameUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    ensureSetup();

    const currentBefore = Missions.current;
    const objectiveBefore = Missions.getObjective(currentBefore);
    if (!objectiveBefore || objectiveBefore.id !== 'clear-hostiles') suppressEnemyPool();

    const out = baseGameUpdate.call(Game, dt, elapsed);

    const currentAfter = Missions.current;
    const objectiveAfter = Missions.getObjective(currentAfter);
    if (objectiveAfter && objectiveAfter.id === 'clear-hostiles') {
      if (!G.combatActive) activateCombat();
    } else if (!G.rewardGranted) {
      suppressEnemyPool();
    } else if (EnemyAI && EnemyAI.enemies) {
      for (let i = 3; i < EnemyAI.enemies.length; i++) hideEnemy(EnemyAI.enemies[i]);
    }

    return out;
  };
})(window);
