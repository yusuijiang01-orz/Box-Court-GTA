/* =============================================================
   js/game/vehicles_interior.js — GTA-02B vehicle presentation

   Lightweight presentation upgrade layered on GTA-02:
   - simple cabin: floor, seats, dashboard and steering wheel;
   - visible seated driver proxy through the existing transparent glass;
   - toggle third-person / cockpit camera while driving;
   - no door animation, IK, detailed gauges or new vehicle physics.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Game || !TOWN.Vehicles) return;

  const Game = TOWN.Game;
  const V = TOWN.Vehicles;

  const B = TOWN.VehicleInterior = {
    version: 'GTA-02B.1',
    view: 'third',
    car: null,
    driver: null,
    initialized: false,
    els: {},
  };

  const tmpEye = new T.Vector3();
  const tmpLook = new T.Vector3();
  const tmpWorld = new T.Vector3();

  const MAT = {
    cabin: new T.MeshStandardMaterial({ color: 0x24282d, roughness: 0.88, metalness: 0.02 }),
    seat: new T.MeshStandardMaterial({ color: 0x31363d, roughness: 0.94, metalness: 0.0 }),
    dash: new T.MeshStandardMaterial({ color: 0x15191d, roughness: 0.76, metalness: 0.08 }),
    trim: new T.MeshStandardMaterial({ color: 0x59616a, roughness: 0.52, metalness: 0.38 }),
    gauge: new T.MeshBasicMaterial({ color: 0xb9d7d0 }),
  };

  function dims(car) {
    const fp = car && car.userData && car.userData.footprint;
    return {
      w: fp && isFinite(fp.w) ? fp.w : 1.9,
      d: fp && isFinite(fp.d) ? fp.d : 4.2,
      h: car && car.userData && isFinite(car.userData.height) ? car.userData.height : 1.5,
    };
  }

  function meshBox(w, h, d, mat, x, y, z) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  }

  function addSeat(parent, x, z, scale, front) {
    const s = scale || 1;
    const base = meshBox(0.48 * s, 0.13 * s, 0.55 * s, MAT.seat, x, 0.53 * s, z);
    parent.add(base);
    const back = meshBox(0.48 * s, 0.60 * s, 0.11 * s, MAT.seat, x, 0.80 * s, z - 0.23 * s);
    back.rotation.x = -0.10;
    parent.add(back);
    if (front) {
      const head = meshBox(0.30 * s, 0.18 * s, 0.10 * s, MAT.seat, x, 1.12 * s, z - 0.25 * s);
      parent.add(head);
    }
  }

  function buildInterior(car) {
    if (!car || !car.userData) return null;
    if (car.userData.gtaInterior) return car.userData.gtaInterior;

    const d = dims(car);
    const g = new T.Group();
    g.name = 'gta02b-interior';

    const floorY = Math.max(0.34, Math.min(0.52, d.h * 0.27));
    const cabinW = Math.max(0.95, d.w * 0.70);
    const cabinD = Math.max(1.30, d.d * 0.46);
    const frontZ = d.d * 0.15;
    const driverX = -Math.min(d.w * 0.22, 0.42);
    const passengerX = -driverX;

    // Floor / centre tunnel.
    g.add(meshBox(cabinW, 0.07, cabinD, MAT.cabin, 0, floorY, -d.d * 0.02));
    g.add(meshBox(0.18, 0.16, cabinD * 0.72, MAT.dash, 0, floorY + 0.09, -d.d * 0.02));

    // Dashboard and shallow instrument binnacle.
    const dashY = Math.max(0.76, Math.min(1.03, d.h * 0.58));
    g.add(meshBox(cabinW * 0.96, 0.17, Math.max(0.18, d.d * 0.08), MAT.dash,
      0, dashY, d.d * 0.205));
    g.add(meshBox(0.38, 0.12, 0.08, MAT.cabin, driverX, dashY + 0.10, d.d * 0.166));

    // Two tiny luminous gauge faces — intentionally abstract, not a real UI.
    for (let i = -1; i <= 1; i += 2) {
      const q = new T.Mesh(new T.CircleGeometry(0.055, 12), MAT.gauge);
      q.position.set(driverX + i * 0.075, dashY + 0.105, d.d * 0.122);
      q.rotation.x = -0.08;
      g.add(q);
    }

    // Steering wheel. Torus is already in the XY plane, facing the driver.
    const wheel = new T.Mesh(new T.TorusGeometry(0.17, 0.026, 6, 18), MAT.trim);
    wheel.position.set(driverX, dashY + 0.01, d.d * 0.085);
    wheel.rotation.x = -0.28;
    g.add(wheel);
    const spokeV = meshBox(0.035, 0.28, 0.035, MAT.trim, driverX, dashY + 0.01, d.d * 0.082);
    spokeV.rotation.z = 0.52;
    spokeV.rotation.x = -0.28;
    g.add(spokeV);

    // Front seats. Larger vehicles also get a low rear bench, still very cheap.
    const seatScale = Math.max(0.82, Math.min(1.08, d.w / 1.85));
    addSeat(g, driverX, frontZ - 0.18, seatScale, true);
    addSeat(g, passengerX, frontZ - 0.18, seatScale, true);
    if (d.d > 3.65) {
      const rearZ = -d.d * 0.16;
      g.add(meshBox(cabinW * 0.92, 0.15, 0.52, MAT.seat, 0, floorY + 0.10, rearZ));
      const rearBack = meshBox(cabinW * 0.92, 0.55, 0.11, MAT.seat, 0, floorY + 0.42, rearZ - 0.22);
      rearBack.rotation.x = -0.08;
      g.add(rearBack);
    }

    // A few userData anchors make later upgrades easy without changing physics.
    g.userData.driverSeat = { x: driverX, y: floorY + 0.12, z: frontZ - 0.18 };
    g.userData.driverEye = {
      x: driverX,
      y: Math.max(1.00, Math.min(1.34, d.h * 0.76)),
      z: Math.max(-0.04, d.d * 0.055),
    };
    g.userData.forwardLookZ = d.d * 0.5 + 18;

    car.add(g);
    car.userData.gtaInterior = g;
    return g;
  }

  function makeDriverProxy(car, interior) {
    if (!car || !interior || !Game.player || !Game.player.o) return null;
    if (car.userData.gtaDriverProxy) return car.userData.gtaDriverProxy;

    // Clone only the visual hierarchy. The real player state remains separate
    // and continues following the car for mission / gameplay coordinates.
    const clone = Game.player.o.clone(true);
    clone.name = 'gta02b-driver';
    clone.visible = true;

    clone.traverse(function (o) {
      // The player's circular contact blob must never appear inside the cabin.
      if (o.isMesh && o.geometry && o.geometry.type === 'CircleGeometry') o.visible = false;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });

    const seat = interior.userData.driverSeat;
    // Compress the standing rig into a readable seated silhouette. From the
    // exterior it reads as the same hero; detailed limb IK is deliberately
    // outside GTA-02B.
    clone.scale.set(0.78, 0.67, 0.78);
    clone.position.set(seat.x, seat.y - 0.03, seat.z - 0.08);
    clone.rotation.set(0, 0, 0);
    car.add(clone);
    car.userData.gtaDriverProxy = clone;
    return clone;
  }

  function prepareCar(car) {
    const interior = buildInterior(car);
    B.driver = makeDriverProxy(car, interior);
    B.car = car;
    if (B.driver) B.driver.visible = B.view !== 'cockpit';
  }

  function releaseCar() {
    if (B.driver) B.driver.visible = false;
    B.driver = null;
    B.car = null;
    B.view = 'third';
    syncViewButton();
  }

  function installStyle() {
    if (document.getElementById('gta02b-style')) return;
    const s = document.createElement('style');
    s.id = 'gta02b-style';
    s.textContent = [
      '#gta02b-view{position:fixed;right:18px;top:126px;z-index:156;display:none;',
      'min-width:82px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.18);',
      'background:rgba(5,8,10,.70);color:#fff;font:700 11px/1 system-ui,-apple-system,sans-serif;}',
      '.gta-vehicle-mode #gta02b-view{display:block;}',
      '#gta02b-view.active{border-color:rgba(255,210,26,.85);color:#ffd21a;}',
      '@media(max-width:700px){#gta02b-view{right:10px;top:112px;min-width:72px;padding:8px 8px;}}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    if (B.els.view) return;
    const b = document.createElement('button');
    b.id = 'gta02b-view';
    b.type = 'button';
    b.textContent = '车内视角';
    b.addEventListener('pointerdown', function (e) {
      if (V.state !== V.STATES.DRIVING) return;
      e.preventDefault();
      e.stopPropagation();
      toggleView();
    });
    document.body.appendChild(b);
    B.els.view = b;
  }

  function syncViewButton() {
    const b = B.els.view;
    if (!b) return;
    const cockpit = B.view === 'cockpit';
    b.textContent = cockpit ? '车外视角' : '车内视角';
    b.classList.toggle('active', cockpit);
  }

  function toggleView() {
    if (V.state !== V.STATES.DRIVING || !V.current || !V.current.car) return;
    B.view = B.view === 'cockpit' ? 'third' : 'cockpit';
    if (B.driver) B.driver.visible = B.view !== 'cockpit';
    syncViewButton();

    // Returning outside should immediately hand the actual camera back to the
    // GTA-02 vehicle camera so there is no one-frame jump.
    if (B.view === 'third' && Game.cam && Game.cam.snap) Game.cam.snap();
  }

  function updateCockpitCamera(dt) {
    const car = B.car;
    if (!car || !car.userData || !car.userData.gtaInterior) return;
    const interior = car.userData.gtaInterior;
    const a = interior.userData.driverEye;
    if (!a) return;

    car.updateMatrixWorld(true);
    tmpEye.set(a.x, a.y, a.z);
    car.localToWorld(tmpEye);
    tmpLook.set(a.x, a.y - 0.04, interior.userData.forwardLookZ || 18);
    car.localToWorld(tmpLook);

    const camera = TOWN.Stage.camera;
    const k = Math.min(1, dt * 18);
    camera.position.lerp(tmpEye, k);
    camera.lookAt(tmpLook);
  }

  function onKeyDown(e) {
    if (!e || e.repeat || V.state !== V.STATES.DRIVING) return;
    if (String(e.key || '').toLowerCase() === 'c') {
      e.preventDefault();
      toggleView();
    }
  }

  B.init = function () {
    if (B.initialized) return;
    B.initialized = true;
    installStyle();
    installDOM();
    global.addEventListener('keydown', onKeyDown);
    syncViewButton();
    console.log('[GTA-02B] cabin + cockpit view ready');
  };

  B.toggleView = toggleView;

  // Load after vehicles.js and observe its state transition rather than
  // replacing GTA-02 internals. This keeps the presentation layer isolated.
  const originalInit = Game.init;
  Game.init = function () {
    const out = originalInit.apply(Game, arguments);
    B.init();
    return out;
  };

  const originalUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!B.initialized) B.init();
    const beforeCar = B.car;
    const out = originalUpdate.call(Game, dt, elapsed);

    const driving = V.state === V.STATES.DRIVING && V.current && V.current.car;
    const nowCar = driving ? V.current.car : null;

    if (nowCar && nowCar !== beforeCar) prepareCar(nowCar);
    else if (!nowCar && beforeCar) releaseCar();

    if (nowCar) {
      if (!B.car) prepareCar(nowCar);
      if (B.driver) B.driver.visible = B.view !== 'cockpit';
      if (B.view === 'cockpit') updateCockpitCamera(dt);
    }

    return out;
  };
})(window);
