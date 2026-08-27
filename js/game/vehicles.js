/* =============================================================
   js/game/vehicles.js — GTA-02 drivable vehicle system

   GTA-02 scope:
   - approach a traffic/parked car and interact to enter;
   - take ownership from the ambient traffic route system;
   - arcade drive / reverse / steer / handbrake;
   - exit and leave the vehicle parked in the world;
   - vehicle follow camera;
   - mobile driving HUD using the existing four action buttons;
   - mission events: vehicleEntered / vehicleExited / reachDestination.

   This file deliberately does NOT implement weapons, enemy AI, wanted level,
   vehicle damage, explosions or NPC car-jacking reactions.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Game || !TOWN.Dynamics || !TOWN.Player) return;

  const U = TOWN.U;
  const Game = TOWN.Game;
  const Dynamics = TOWN.Dynamics;
  const Collision = TOWN.CollisionV1;
  const Missions = TOWN.Missions;

  const STATES = Object.freeze({
    ON_FOOT: 'ON_FOOT',
    DRIVING: 'DRIVING',
  });

  const V = TOWN.Vehicles = {
    version: 'GTA-02.1',
    state: STATES.ON_FOOT,
    STATES: STATES,
    current: null,
    parked: [],
    initialized: false,
    touch: { throttle: false, brake: false, handbrake: false },
    els: {},
    savedButtons: null,
    footCam: null,
    vehicleCam: null,
  };

  const tmpPos = new T.Vector3();
  const tmpPos2 = new T.Vector3();
  const tmpLook = new T.Vector3();
  const tmpCam = new T.Vector3();

  function sampleSurface(x, z) {
    if (Collision && Collision.sample) return Collision.sample(x, z);
    return TOWN.Island.sample(x, z);
  }

  function heightAt(x, z) {
    const s = sampleSurface(x, z);
    return s && isFinite(s.y) ? s.y : TOWN.Island.heightAt(x, z);
  }

  function vehicleDims(car) {
    const fp = car && car.userData && car.userData.footprint;
    return {
      w: fp && isFinite(fp.w) ? fp.w : 1.9,
      d: fp && isFinite(fp.d) ? fp.d : 4.2,
    };
  }

  function pointBlocked(x, z, radius, ignoreCollider) {
    const cols = TOWN.Colliders || [];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c || c === ignoreCollider) continue;
      const dx = x - c.x, dz = z - c.z;
      const rr = radius + (c.r || Math.hypot(c.w || 0, c.d || 0) * 0.5);
      if (dx * dx + dz * dz > rr * rr) continue;
      const co = Math.cos(c.rot || 0), si = Math.sin(c.rot || 0);
      const lx = co * dx - si * dz;
      const lz = si * dx + co * dz;
      if (Math.abs(lx) < (c.w || 0) * 0.5 + radius &&
          Math.abs(lz) < (c.d || 0) * 0.5 + radius) return true;
    }
    return false;
  }

  function nearMovingVehicle(x, z, radius, ownCar) {
    const systems = Dynamics._systems;
    const veh = systems && systems.VEH ? systems.VEH : [];
    const rrExtra = radius + 1.45;
    const r2 = rrExtra * rrExtra;
    for (let i = 0; i < veh.length; i++) {
      const m = veh[i];
      if (!m || !m.parts) continue;
      for (let k = 0; k < m.parts.length; k++) {
        const pt = m.parts[k];
        if (!pt || pt.joint || !pt.o || pt.o === ownCar) continue;
        // Cars, trams and other route vehicles all count as physical traffic.
        pt.o.getWorldPosition(tmpPos2);
        const dx = x - tmpPos2.x, dz = z - tmpPos2.z;
        if (dx * dx + dz * dz < r2) return true;
      }
    }
    return false;
  }

  function removeCollider(collider) {
    if (!collider) return;
    const cols = TOWN.Colliders || [];
    const ix = cols.indexOf(collider);
    if (ix >= 0) cols.splice(ix, 1);
  }

  function makeParkedCollider(car) {
    const d = vehicleDims(car);
    const c = {
      x: car.position.x,
      z: car.position.z,
      w: Math.max(1.15, d.w * 0.88),
      d: Math.max(2.1, d.d * 0.88),
      rot: car.rotation.y || 0,
      name: 'parkedVehicle',
      type: 'SOLID',
      source: 'GTA-02',
    };
    c.r = Math.hypot(c.w, c.d) * 0.5;
    if (!TOWN.Colliders) TOWN.Colliders = [];
    TOWN.Colliders.push(c);
    return c;
  }

  function detachTrafficCar(candidate) {
    if (!candidate || candidate.parked) return candidate;
    const systems = Dynamics._systems;
    const veh = systems && systems.VEH ? systems.VEH : [];
    if (candidate.entry) {
      const ix = veh.indexOf(candidate.entry);
      if (ix >= 0) veh.splice(ix, 1);
    }

    const car = candidate.car;
    const scene = TOWN.Stage && TOWN.Stage.scene;
    if (scene && car && car.parent !== scene) {
      car.updateMatrixWorld(true);
      if (scene.attach) scene.attach(car);
      else {
        car.getWorldPosition(tmpPos);
        const q = new T.Quaternion();
        const s = new T.Vector3();
        car.getWorldQuaternion(q);
        car.getWorldScale(s);
        if (car.parent) car.parent.remove(car);
        scene.add(car);
        car.position.copy(tmpPos);
        car.quaternion.copy(q);
        car.scale.copy(s);
      }
    }
    car.rotation.x = 0;
    car.rotation.z = 0;
    car.userData.gtaDrivable = true;
    return candidate;
  }

  function movingCandidates() {
    const systems = Dynamics._systems;
    return systems && systems.VEH ? systems.VEH : [];
  }

  function nearestVehicle(range) {
    if (!Game.player || !Game.player.o) return null;
    const p = Game.player.o.position;
    const max2 = range * range;
    let best = null;
    let best2 = max2;

    const veh = movingCandidates();
    for (let i = 0; i < veh.length; i++) {
      const m = veh[i];
      if (!m || !m.parts || m.parts.length !== 1) continue;
      const pt = m.parts[0];
      const car = pt && pt.o;
      if (!car || !car.userData || car.userData.kind !== 'car') continue;
      car.getWorldPosition(tmpPos);
      const dx = tmpPos.x - p.x, dz = tmpPos.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) {
        best2 = d2;
        best = { car: car, entry: m, parked: false, speed: m.vel || m.spd || 0 };
      }
    }

    for (let i = 0; i < V.parked.length; i++) {
      const pk = V.parked[i];
      if (!pk || !pk.car) continue;
      const car = pk.car;
      const dx = car.position.x - p.x, dz = car.position.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) {
        best2 = d2;
        best = { car: car, parked: true, parkedRecord: pk, speed: 0 };
      }
    }

    if (best) best.distance = Math.sqrt(best2);
    return best;
  }

  /* ===========================================================
     Vehicle camera
     =========================================================== */
  function VehicleCam(camera, car) {
    this.camera = camera;
    this.car = car;
    this.orbitYaw = 0;
    this.targetPitch = 0.48;
    this.curPitch = this.targetPitch;
    this.targetDist = 8.2;
    this.curDist = this.targetDist;
    this.curYaw = (car.rotation.y || 0) + Math.PI;
    this.viewYaw = this.curYaw;
    this.enabled = true;
  }

  VehicleCam.prototype.rotateBy = function (dyaw, dpitch) {
    this.orbitYaw += dyaw;
    this.targetPitch = U.clamp(this.targetPitch + dpitch, 0.16, 1.15);
  };

  VehicleCam.prototype.zoomBy = function (k) {
    this.targetDist = U.clamp(this.targetDist * k, 5.2, 15.5);
  };

  VehicleCam.prototype.snap = function () {
    if (!this.car) return;
    this.curYaw = (this.car.rotation.y || 0) + Math.PI + this.orbitYaw;
    this.curPitch = this.targetPitch;
    this.curDist = this.targetDist;
    this.update(1);
  };

  VehicleCam.prototype.update = function (dt) {
    const car = this.car;
    if (!car) return;
    const speed = V.current ? Math.abs(V.current.speed || 0) : 0;
    const desiredYaw = (car.rotation.y || 0) + Math.PI + this.orbitYaw;
    this.curYaw += U.angleDelta(this.curYaw, desiredYaw) * Math.min(1, dt * 5.8);
    this.curPitch = U.damp(this.curPitch, this.targetPitch, 8, dt);
    const desiredDist = this.targetDist + Math.min(2.0, speed * 0.10);
    this.curDist = U.damp(this.curDist, desiredDist, 7, dt);

    tmpLook.set(car.position.x, car.position.y + 1.25, car.position.z);
    const cp = Math.cos(this.curPitch), sp = Math.sin(this.curPitch);
    tmpCam.set(
      tmpLook.x + Math.sin(this.curYaw) * this.curDist * cp,
      tmpLook.y + this.curDist * sp,
      tmpLook.z + Math.cos(this.curYaw) * this.curDist * cp
    );
    const gy = heightAt(tmpCam.x, tmpCam.z) + 0.75;
    if (tmpCam.y < gy) tmpCam.y = gy;
    this.camera.position.lerp(tmpCam, Math.min(1, dt * 11));
    this.camera.lookAt(tmpLook);
    this.viewYaw = this.curYaw;
  };

  /* ===========================================================
     HUD
     =========================================================== */
  function installStyle() {
    if (document.getElementById('gta02-style')) return;
    const s = document.createElement('style');
    s.id = 'gta02-style';
    s.textContent = [
      '#gta02-vehicle-prompt{position:fixed;left:50%;bottom:128px;transform:translateX(-50%);z-index:155;',
      'padding:9px 14px;border-radius:8px;background:rgba(8,10,12,.82);border:1px solid rgba(255,210,26,.75);',
      'color:#fff;font:600 13px/1.2 system-ui,-apple-system,sans-serif;pointer-events:none;white-space:nowrap;}',
      '#gta02-vehicle-prompt.hidden,#gta02-speed.hidden{display:none!important;}',
      '#gta02-speed{position:fixed;right:18px;top:76px;z-index:154;min-width:82px;text-align:right;',
      'padding:8px 10px;border-radius:8px;background:rgba(5,8,10,.66);color:#fff;font:700 16px/1.05 ui-monospace,monospace;',
      'border:1px solid rgba(255,255,255,.16);pointer-events:none;}',
      '#gta02-speed small{display:block;margin-top:3px;font:600 9px/1 system-ui,sans-serif;color:rgba(255,255,255,.65);letter-spacing:.12em;}',
      '.gta-vehicle-mode .actionpad .hud-btn.act{font:800 11px/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em;}',
      '.gta-veh-label{pointer-events:none;}',
      '@media(max-width:700px){#gta02-vehicle-prompt{bottom:118px;font-size:12px;padding:8px 11px;}#gta02-speed{right:10px;top:66px;}}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (!V.els.prompt) {
      const p = document.createElement('div');
      p.id = 'gta02-vehicle-prompt';
      p.className = 'hidden';
      p.innerHTML = '<b>E / 交互</b>　上车';
      document.body.appendChild(p);
      V.els.prompt = p;
    }
    if (!V.els.speed) {
      const sp = document.createElement('div');
      sp.id = 'gta02-speed';
      sp.className = 'hidden';
      sp.innerHTML = '0 <small>KM/H</small>';
      document.body.appendChild(sp);
      V.els.speed = sp;
    }
  }

  function saveButtons() {
    if (V.savedButtons) return;
    const names = ['run', 'jump', 'attack', 'interact'];
    V.savedButtons = {};
    for (let i = 0; i < names.length; i++) {
      const b = document.querySelector('.actionpad [data-name="' + names[i] + '"]');
      if (!b) continue;
      V.savedButtons[names[i]] = { el: b, html: b.innerHTML, title: b.title };
    }
  }

  function setVehicleButtons(on) {
    saveButtons();
    document.body.classList.toggle('gta-vehicle-mode', !!on);
    if (!V.savedButtons) return;
    const labels = { run: '手刹', jump: '油门', attack: '刹车', interact: '下车' };
    for (const name in V.savedButtons) {
      const rec = V.savedButtons[name];
      if (!rec.el) continue;
      if (on) {
        rec.el.innerHTML = '<span class="gta-veh-label">' + labels[name] + '</span>';
        rec.el.title = labels[name];
      } else {
        rec.el.innerHTML = rec.html;
        rec.el.title = rec.title;
        rec.el.classList.remove('active');
      }
    }
  }

  function bindVehicleTouch() {
    saveButtons();
    if (!V.savedButtons || V._touchBound) return;
    V._touchBound = true;

    function bindHold(name, field) {
      const rec = V.savedButtons[name];
      if (!rec || !rec.el) return;
      rec.el.addEventListener('pointerdown', function () {
        if (V.state === STATES.DRIVING) V.touch[field] = true;
      });
      const up = function () { V.touch[field] = false; };
      global.addEventListener('pointerup', up);
      global.addEventListener('pointercancel', up);
    }
    bindHold('jump', 'throttle');
    bindHold('attack', 'brake');
    bindHold('run', 'handbrake');
  }

  function setPrompt(show, text) {
    if (!V.els.prompt) return;
    if (text) V.els.prompt.innerHTML = text;
    V.els.prompt.classList.toggle('hidden', !show);
  }

  function updateSpeedHUD() {
    if (!V.els.speed) return;
    const driving = V.state === STATES.DRIVING && V.current;
    V.els.speed.classList.toggle('hidden', !driving);
    if (driving) {
      const kmh = Math.round(Math.abs(V.current.speed) * 3.6);
      V.els.speed.innerHTML = kmh + ' <small>KM/H</small>';
    }
  }

  function clearDriveInputEdges() {
    const input = Game.input;
    if (!input || !input.state) return;
    input.state.jumpPressed = false;
    input.state.attackPressed = false;
    input.state.run = false;
    if (input._held) input._held.run = false;
    V.touch.throttle = V.touch.brake = V.touch.handbrake = false;
  }

  /* ===========================================================
     Enter / exit
     =========================================================== */
  function enterVehicle(candidate) {
    if (!candidate || !candidate.car || !Game.player) return false;
    if (candidate.parked && candidate.parkedRecord) {
      removeCollider(candidate.parkedRecord.collider);
      const ix = V.parked.indexOf(candidate.parkedRecord);
      if (ix >= 0) V.parked.splice(ix, 1);
    } else {
      detachTrafficCar(candidate);
    }

    const car = candidate.car;
    const dims = vehicleDims(car);
    const input = Game.input;
    if (input && input.consume) input.consume('interactPressed');

    V.footCam = Game.cam;
    V.current = {
      car: car,
      speed: U.clamp(candidate.speed || 0, -1.5, 5.5),
      steer: 0,
      width: dims.w,
      length: dims.d,
      wheelR: car.userData.wheelR || 0.34,
      entry: candidate.entry || null,
    };
    V.state = STATES.DRIVING;
    Game.vehicleState = V.state;
    Game.vehicle = car;

    // The hidden player follows the vehicle so existing mission distance logic
    // continues to work without rewriting GTA-01.
    Game.player.o.visible = false;
    Game.player.o.position.copy(car.position);
    Game.player.vy = 0;
    Game.player.onGround = true;
    Game.player.speed = 0;

    V.vehicleCam = new VehicleCam(TOWN.Stage.camera, car);
    Game.cam = V.vehicleCam;
    V.vehicleCam.snap();

    const dlg = document.getElementById('dialogue');
    if (dlg) dlg.classList.add('hidden');
    setVehicleButtons(true);
    setPrompt(false);
    updateSpeedHUD();

    if (Missions && Missions.emit) {
      Missions.emit('vehicleEntered', {
        vehicle: car,
        type: car.userData.type || 'car',
        position: car.position.clone(),
      });
    }
    console.log('[GTA-02] entered vehicle:', car.userData.type || 'car');
    return true;
  }

  function validExitPoint(car, side) {
    const yaw = car.rotation.y || 0;
    const dims = vehicleDims(car);
    const off = dims.w * 0.5 + 1.05;
    const x = car.position.x + Math.cos(yaw) * off * side;
    const z = car.position.z - Math.sin(yaw) * off * side;
    const s = sampleSurface(x, z);
    if (!s || !s.land || pointBlocked(x, z, 0.48, null)) return null;
    return { x: x, y: s.y, z: z };
  }

  function exitVehicle() {
    const cur = V.current;
    if (!cur || !cur.car || !Game.player) return false;
    if (Math.abs(cur.speed) > 1.8) {
      setPrompt(true, '请先减速　<small>低于 7 km/h 后可下车</small>');
      return false;
    }

    const car = cur.car;
    let pt = validExitPoint(car, 1) || validExitPoint(car, -1);
    if (!pt) {
      const yaw = car.rotation.y || 0;
      const back = vehicleDims(car).d * 0.5 + 1.0;
      const x = car.position.x - Math.sin(yaw) * back;
      const z = car.position.z - Math.cos(yaw) * back;
      const s = sampleSurface(x, z);
      if (s && s.land && !pointBlocked(x, z, 0.48, null)) pt = { x: x, y: s.y, z: z };
    }
    if (!pt) {
      setPrompt(true, '这里无法安全下车');
      return false;
    }

    if (Game.input && Game.input.consume) Game.input.consume('interactPressed');
    cur.speed = 0;
    car.rotation.x = 0;
    car.rotation.z = 0;

    const collider = makeParkedCollider(car);
    V.parked.push({ car: car, collider: collider });

    Game.player.o.position.set(pt.x, pt.y, pt.z);
    Game.player.o.visible = true;
    Game.player.vy = 0;
    Game.player.onGround = true;
    Game.player.speed = 0;
    Game.player.yaw = car.rotation.y;
    Game.player.moveYaw = car.rotation.y;

    V.state = STATES.ON_FOOT;
    Game.vehicleState = V.state;
    Game.vehicle = null;
    V.current = null;
    V.vehicleCam = null;
    Game.cam = V.footCam || new TOWN.FollowCam(TOWN.Stage.camera, Game.player);
    V.footCam = null;
    if (Game.cam && Game.cam.snap) Game.cam.snap();

    clearDriveInputEdges();
    setVehicleButtons(false);
    setPrompt(false);
    updateSpeedHUD();

    if (Missions && Missions.emit) {
      Missions.emit('vehicleExited', {
        vehicle: car,
        type: car.userData.type || 'car',
        position: car.position.clone(),
      });
    }
    console.log('[GTA-02] exited vehicle');
    return true;
  }

  /* ===========================================================
     Driving physics
     =========================================================== */
  function updateVehicle(dt, elapsed) {
    const cur = V.current;
    const car = cur && cur.car;
    const input = Game.input;
    if (!cur || !car || !input) return;

    input.update(dt);
    const st = input.state;
    const keys = input._keys || {};
    const touchJoy = !!(input._joy && input._joy.active);

    // Desktop: W/S throttle + A/D steer. Mobile: left stick steers, dedicated
    // accelerator/brake buttons provide longitudinal input.
    const steer = U.clamp(st.move ? st.move.x : 0, -1, 1);
    let throttle;
    if (touchJoy || V.touch.throttle || V.touch.brake) {
      throttle = (V.touch.throttle ? 1 : 0) - (V.touch.brake ? 1 : 0);
    } else {
      throttle = U.clamp(st.move ? st.move.y : 0, -1, 1);
    }
    const handbrake = !!(V.touch.handbrake || keys[' '] || (input._held && input._held.run));

    if (st.interactPressed) {
      input.consume('interactPressed');
      if (exitVehicle()) return;
    }

    // These are on-foot actions; while driving their buttons are repurposed.
    st.jumpPressed = false;
    st.attackPressed = false;

    const MAX_FWD = 13.2;     // ~47 km/h: appropriate for the compact town
    const MAX_REV = 5.2;
    const ACCEL = 7.8;
    const BRAKE = 12.0;
    const REV_ACCEL = 5.8;

    if (throttle > 0.05) {
      if (cur.speed < -0.4) cur.speed += BRAKE * throttle * dt;
      else cur.speed += ACCEL * throttle * dt;
    } else if (throttle < -0.05) {
      const b = -throttle;
      if (cur.speed > 0.45) cur.speed -= BRAKE * b * dt;
      else cur.speed -= REV_ACCEL * b * dt;
    } else {
      cur.speed = U.damp(cur.speed, 0, handbrake ? 7.5 : 0.72, dt);
    }
    if (handbrake) cur.speed = U.damp(cur.speed, 0, 4.8, dt);
    cur.speed = U.clamp(cur.speed, -MAX_REV, MAX_FWD);

    const absSpd = Math.abs(cur.speed);
    if (absSpd > 0.08 && Math.abs(steer) > 0.02) {
      const direction = cur.speed >= 0 ? 1 : -1;
      const speedFactor = U.clamp(absSpd / 3.0, 0.24, 1.0);
      const steerRate = handbrake ? 1.75 : 1.15;
      car.rotation.y += steer * steerRate * speedFactor * direction * dt;
    }

    const yaw = car.rotation.y || 0;
    const travel = cur.speed * dt;
    const nx = car.position.x + Math.sin(yaw) * travel;
    const nz = car.position.z + Math.cos(yaw) * travel;
    const ns = sampleSurface(nx, nz);
    const radius = Math.max(0.72, cur.width * 0.43);
    let blocked = !ns || !ns.land;
    if (!blocked && pointBlocked(nx, nz, radius, null)) blocked = true;
    if (!blocked && nearMovingVehicle(nx, nz, radius, car)) blocked = true;
    // Don't let a car teleport vertically onto a roof/high terrace.
    if (!blocked && isFinite(ns.y) && ns.y - car.position.y > 0.72) blocked = true;

    if (!blocked) {
      car.position.x = nx;
      car.position.z = nz;
      car.position.y = U.damp(car.position.y, ns.y, 12, dt);
      const wheels = car.userData.wheels || [];
      for (let i = 0; i < wheels.length; i++) {
        wheels[i].rotation.x = (wheels[i].rotation.x - travel / cur.wheelR) % (Math.PI * 2);
      }
    } else if (absSpd > 0.05) {
      cur.speed *= -0.10;
    }

    car.rotation.x = 0;
    car.rotation.z = U.damp(car.rotation.z, -steer * U.clamp(absSpd / MAX_FWD, 0, 1) * 0.06, 5, dt);

    // Keep hidden player at the driver's location for GTA-01 reach objectives.
    Game.player.o.position.copy(car.position);
    Game.player.yaw = car.rotation.y;
    Game.player.moveYaw = car.rotation.y;

    if (Missions && Missions.preUpdate) Missions.preUpdate(Game, dt, elapsed);
    if (Missions && Missions.emit) {
      Missions.emit('reachDestination', {
        vehicle: car,
        type: car.userData.type || 'car',
        position: car.position.clone(),
        speed: cur.speed,
      });
    }

    if (Game.cam && Game.cam.update) Game.cam.update(dt);
    updateSpeedHUD();
    setPrompt(false);
  }

  function updateOnFootPrompt() {
    if (V.state !== STATES.ON_FOOT || Game.mode !== 'play' || Game.settingsOpen) {
      if (V.state !== STATES.DRIVING) setPrompt(false);
      return null;
    }
    const n = nearestVehicle(2.8);
    if (!n) {
      setPrompt(false);
      return null;
    }
    const type = n.car && n.car.userData ? (n.car.userData.type || '汽车') : '汽车';
    setPrompt(true, '<b>E / 交互</b>　上车 <small>' + type + '</small>');
    return n;
  }

  /* ===========================================================
     Integration
     =========================================================== */
  V.init = function () {
    if (V.initialized) return;
    V.initialized = true;
    installStyle();
    installDOM();
    bindVehicleTouch();
    Game.vehicleState = STATES.ON_FOOT;
    console.log('[GTA-02] vehicle system ready');
  };

  const originalInit = Game.init;
  Game.init = function () {
    const out = originalInit.apply(Game, arguments);
    V.init();
    return out;
  };

  const originalUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!V.initialized) V.init();

    if (V.state === STATES.DRIVING) {
      updateVehicle(dt, elapsed);
      return;
    }

    // Vehicle interaction gets first refusal over resident dialogue/mission
    // interaction when the player is physically beside a car.
    const input = Game.input;
    const candidate = updateOnFootPrompt();
    if (candidate && input && input.state && input.state.interactPressed) {
      if (enterVehicle(candidate)) return;
    }

    const out = originalUpdate.call(Game, dt, elapsed);
    updateOnFootPrompt();
    updateSpeedHUD();
    return out;
  };

  V.enter = enterVehicle;
  V.exit = exitVehicle;
  V.nearest = nearestVehicle;
})(window);
