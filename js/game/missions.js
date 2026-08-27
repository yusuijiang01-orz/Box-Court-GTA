/* =============================================================
   js/game/missions.js — GTA-01 mission foundation

   Small, data-driven mission state machine designed to sit beside
   TOWN.Game without taking ownership of player movement, dialogue,
   vehicles or combat. GTA-01 ships one reach objective: 前往码头.
   ============================================================= */
(function (global) {
  'use strict';
  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Game) return;

  const STATES = Object.freeze({
    LOCKED: 'LOCKED',
    AVAILABLE: 'AVAILABLE',
    ACTIVE: 'ACTIVE',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  });

  const Missions = TOWN.Missions = {
    STATES: STATES,
    registry: Object.create(null),
    current: null,
    initialized: false,
    startMarker: null,
    targetMarker: null,
    els: {},
    completionTimer: 0,
  };

  // Coordinates are X/Z. Y is sampled from the live island at runtime.
  const TEST_MISSION = {
    id: 'gta01-harbour-run',
    title: '前往码头',
    start: { x: 4, z: -6, radius: 3.0 },
    objectives: [
      {
        id: 'reach-harbour',
        type: 'reach',
        label: '前往码头',
        position: { x: 16, z: 26 },
        radius: 5.0,
      },
    ],
  };

  Missions.register = function (definition) {
    if (!definition || !definition.id || !definition.objectives || !definition.objectives.length) {
      throw new Error('[Missions] invalid mission definition');
    }
    const copy = {
      id: definition.id,
      title: definition.title || definition.id,
      start: definition.start || null,
      objectives: definition.objectives.slice(),
      state: definition.state || STATES.AVAILABLE,
      objectiveIndex: 0,
    };
    Missions.registry[copy.id] = copy;
    return copy;
  };

  Missions.get = function (id) {
    return Missions.registry[id] || null;
  };

  Missions.getObjective = function (mission) {
    mission = mission || Missions.current;
    if (!mission || mission.state !== STATES.ACTIVE) return null;
    return mission.objectives[mission.objectiveIndex] || null;
  };

  function groundY(x, z) {
    const Island = TOWN.Island;
    if (!Island) return 0;
    if (Island.heightAt) return Island.heightAt(x, z);
    if (Island.sample) return Island.sample(x, z).y;
    return 0;
  }

  function makeMarker(scale, opacity) {
    const g = new T.Group();
    g.userData.kind = 'missionMarker';

    const yellow = 0xffd21a;
    const ring = new T.Mesh(
      new T.RingGeometry(0.82 * scale, 1.08 * scale, 32),
      new T.MeshBasicMaterial({
        color: yellow,
        transparent: true,
        opacity: Math.min(1, opacity + 0.2),
        side: T.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);

    const column = new T.Mesh(
      new T.CylinderGeometry(0.78 * scale, 0.78 * scale, 2.2 * scale, 28, 1, true),
      new T.MeshBasicMaterial({
        color: yellow,
        transparent: true,
        opacity: opacity,
        side: T.DoubleSide,
        depthWrite: false,
        blending: T.AdditiveBlending,
      })
    );
    column.position.y = 1.1 * scale;
    g.add(column);

    const arrow = new T.Mesh(
      new T.ConeGeometry(0.42 * scale, 0.72 * scale, 20),
      new T.MeshBasicMaterial({
        color: yellow,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      })
    );
    arrow.rotation.z = Math.PI;
    arrow.position.y = 2.65 * scale;
    g.add(arrow);

    g.userData.ring = ring;
    g.userData.column = column;
    g.userData.arrow = arrow;
    g.visible = false;
    return g;
  }

  function placeMarker(marker, p) {
    if (!marker || !p) return;
    marker.position.set(p.x, groundY(p.x, p.z) + 0.03, p.z);
  }

  function installStyle() {
    if (document.getElementById('mission-style')) return;
    const style = document.createElement('style');
    style.id = 'mission-style';
    style.textContent = `
      #mission-hud {
        position: fixed; left: max(18px, env(safe-area-inset-left)); top: 92px;
        z-index: 14; width: min(330px, calc(100vw - 36px));
        pointer-events: none; color: #fff; text-shadow: 0 2px 5px rgba(0,0,0,.85);
        font-family: "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      }
      #mission-hud .mh-card {
        background: linear-gradient(90deg, rgba(7,9,12,.78), rgba(7,9,12,.34));
        border-left: 4px solid #ffd21a; padding: 10px 13px 11px;
        box-shadow: 0 5px 18px rgba(0,0,0,.22);
      }
      #mission-hud .mh-kicker {
        color: #ffd21a; font-size: 10px; font-weight: 800; letter-spacing: .22em;
        text-transform: uppercase; margin-bottom: 3px;
      }
      #mission-hud .mh-title { font-size: 18px; font-weight: 800; letter-spacing: .04em; }
      #mission-hud .mh-objective { margin-top: 5px; font-size: 13px; font-weight: 600; }
      #mission-hud .mh-distance { margin-top: 3px; font-size: 11px; opacity: .78; }
      #mission-prompt {
        position: fixed; left: 50%; bottom: max(112px, calc(env(safe-area-inset-bottom) + 92px));
        transform: translateX(-50%); z-index: 16; pointer-events: none;
        padding: 9px 15px; border-radius: 5px; color: #fff; background: rgba(4,5,7,.78);
        border: 1px solid rgba(255,210,26,.72); box-shadow: 0 5px 18px rgba(0,0,0,.28);
        font: 700 13px/1.2 "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        white-space: nowrap; text-shadow: 0 1px 2px #000;
      }
      #mission-prompt b { color: #ffd21a; }
      #mission-toast {
        position: fixed; left: 50%; top: 18%; transform: translate(-50%,-50%);
        z-index: 17; pointer-events: none; color: #ffd21a; text-align: center;
        font: 900 clamp(24px, 5vw, 42px)/1.05 "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        letter-spacing: .12em; text-shadow: 0 3px 9px rgba(0,0,0,.9);
      }
      #mission-toast small { display: block; margin-top: 8px; color: #fff; font-size: 12px; letter-spacing: .12em; }
      @media (max-width: 760px) {
        #mission-hud { top: 70px; left: max(12px, env(safe-area-inset-left)); width: min(290px, calc(100vw - 24px)); }
        #mission-hud .mh-card { padding: 8px 10px 9px; }
        #mission-hud .mh-title { font-size: 16px; }
        #mission-prompt { bottom: max(104px, calc(env(safe-area-inset-bottom) + 84px)); font-size: 12px; }
      }
    `;
    document.head.appendChild(style);
  }

  function installDOM() {
    const hud = document.createElement('div');
    hud.id = 'mission-hud';
    hud.className = 'hidden';
    hud.innerHTML = '<div class="mh-card"><div class="mh-kicker">MISSION</div>' +
      '<div class="mh-title" id="mission-title"></div>' +
      '<div class="mh-objective" id="mission-objective"></div>' +
      '<div class="mh-distance" id="mission-distance"></div></div>';
    document.body.appendChild(hud);

    const prompt = document.createElement('div');
    prompt.id = 'mission-prompt';
    prompt.className = 'hidden';
    prompt.innerHTML = '<b>E / 交互</b>　开始任务';
    document.body.appendChild(prompt);

    const toast = document.createElement('div');
    toast.id = 'mission-toast';
    toast.className = 'hidden';
    toast.innerHTML = '任务完成<small>前往码头</small>';
    document.body.appendChild(toast);

    Missions.els.hud = hud;
    Missions.els.title = hud.querySelector('#mission-title');
    Missions.els.objective = hud.querySelector('#mission-objective');
    Missions.els.distance = hud.querySelector('#mission-distance');
    Missions.els.prompt = prompt;
    Missions.els.toast = toast;
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
  }

  function distanceXZ(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  Missions.start = function (id) {
    const mission = Missions.get(id);
    if (!mission || mission.state !== STATES.AVAILABLE) return false;
    mission.state = STATES.ACTIVE;
    mission.objectiveIndex = 0;
    Missions.current = mission;
    Missions.completionTimer = 0;
    setHidden(Missions.els.prompt, true);
    setHidden(Missions.els.toast, true);
    if (Missions.startMarker) Missions.startMarker.visible = false;
    const objective = Missions.getObjective(mission);
    if (objective && objective.position) placeMarker(Missions.targetMarker, objective.position);
    console.log('[Missions] started:', mission.id);
    return true;
  };

  Missions.completeObjective = function () {
    const mission = Missions.current;
    if (!mission || mission.state !== STATES.ACTIVE) return false;
    mission.objectiveIndex++;
    if (mission.objectiveIndex >= mission.objectives.length) {
      mission.state = STATES.COMPLETED;
      Missions.current = null;
      Missions.completionTimer = 3.2;
      if (Missions.targetMarker) Missions.targetMarker.visible = false;
      setHidden(Missions.els.hud, true);
      setHidden(Missions.els.toast, false);
      console.log('[Missions] completed:', mission.id);
      return true;
    }
    const next = Missions.getObjective(mission);
    if (next && next.position) placeMarker(Missions.targetMarker, next.position);
    return true;
  };

  // Extension point for GTA-02+ objectives (vehicleEntered, enemyKilled, shotFired...).
  Missions.emit = function (eventName, payload) {
    const objective = Missions.getObjective();
    if (!objective || objective.type === 'reach') return false;
    if (objective.event && objective.event !== eventName) return false;
    if (typeof objective.test === 'function' && !objective.test(payload, objective)) return false;
    return Missions.completeObjective();
  };

  function animateMarker(marker, t, active) {
    if (!marker || !marker.visible) return;
    const pulse = 1 + Math.sin(t * 4.2) * 0.06;
    marker.userData.ring.scale.setScalar(pulse);
    marker.userData.arrow.position.y = (active ? 2.85 : 2.65) + Math.sin(t * 3.0) * 0.18;
    marker.userData.arrow.rotation.y = t * 1.25;
  }

  Missions.preUpdate = function (game, dt, elapsed) {
    if (!Missions.initialized) return;

    const inPlay = game && game.mode === 'play' && !game.settingsOpen && game.player;
    const available = Missions.get(TEST_MISSION.id);
    if (!inPlay) {
      if (Missions.startMarker) Missions.startMarker.visible = false;
      if (Missions.targetMarker) Missions.targetMarker.visible = false;
      setHidden(Missions.els.prompt, true);
      setHidden(Missions.els.hud, true);
      return;
    }

    const playerPos = game.player.o.position;
    const input = game.input && game.input.state;

    if (available && available.state === STATES.AVAILABLE) {
      Missions.startMarker.visible = true;
      const dStart = distanceXZ(playerPos, available.start);
      const near = dStart <= available.start.radius;
      setHidden(Missions.els.prompt, !near);
      if (near && input && input.interactPressed) {
        Missions.start(available.id);
        // Mission interaction wins over resident dialogue on this frame.
        if (game.input && game.input.consume) game.input.consume('interactPressed');
      }
    } else {
      if (Missions.startMarker) Missions.startMarker.visible = false;
      setHidden(Missions.els.prompt, true);
    }

    const mission = Missions.current;
    const objective = Missions.getObjective(mission);
    if (mission && objective) {
      setHidden(Missions.els.hud, false);
      Missions.els.title.textContent = mission.title;
      Missions.els.objective.textContent = objective.label || objective.id;

      if (objective.position) {
        Missions.targetMarker.visible = true;
        const d = distanceXZ(playerPos, objective.position);
        Missions.els.distance.textContent = '目标距离 ' + Math.max(0, Math.round(d)) + ' m';
        if (objective.type === 'reach' && d <= (objective.radius || 3)) {
          Missions.completeObjective();
        }
      } else {
        Missions.targetMarker.visible = false;
        Missions.els.distance.textContent = '';
      }
    } else if (!Missions.completionTimer) {
      setHidden(Missions.els.hud, true);
      if (Missions.targetMarker) Missions.targetMarker.visible = false;
    }

    if (Missions.completionTimer > 0) {
      Missions.completionTimer = Math.max(0, Missions.completionTimer - dt);
      if (Missions.completionTimer === 0) setHidden(Missions.els.toast, true);
    }

    animateMarker(Missions.startMarker, elapsed, false);
    animateMarker(Missions.targetMarker, elapsed, true);
  };

  Missions.init = function (game) {
    if (Missions.initialized) return;
    Missions.initialized = true;
    installStyle();
    installDOM();
    Missions.register(TEST_MISSION);

    const scene = TOWN.Stage && TOWN.Stage.scene;
    if (scene) {
      Missions.startMarker = makeMarker(0.92, 0.18);
      Missions.targetMarker = makeMarker(1.18, 0.23);
      placeMarker(Missions.startMarker, TEST_MISSION.start);
      placeMarker(Missions.targetMarker, TEST_MISSION.objectives[0].position);
      scene.add(Missions.startMarker);
      scene.add(Missions.targetMarker);
    }

    console.log('[Missions] GTA-01 ready');
  };

  // Non-invasive integration: missions load after shell.js and wrap its public
  // init/update methods. No player, input, dialogue or world code is replaced.
  const Game = TOWN.Game;
  const gameInit = Game.init;
  const gameUpdate = Game.update;

  Game.init = function () {
    const out = gameInit.apply(Game, arguments);
    Missions.init(Game);
    return out;
  };

  Game.update = function (dt, elapsed) {
    Missions.preUpdate(Game, dt, elapsed);
    return gameUpdate.call(Game, dt, elapsed);
  };
})(window);
