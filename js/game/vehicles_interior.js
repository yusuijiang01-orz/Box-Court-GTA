/* =============================================================
   js/game/vehicles_interior.js — GTA-02B vehicle presentation

   Lightweight presentation upgrade layered on GTA-02:
   - simple cabin: floor, seats, dashboard and steering wheel;
   - vehicle-only transparent glazing (building window materials untouched);
   - cut real window openings out of the original opaque cabin shell;
   - visible seated driver proxy through the glass;
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
    version: 'GTA-02B.2',
    view: 'third',
    car: null,
    driver: null,
    initialized: false,
    els: {},
  };

  const tmpEye = new T.Vector3();
  const tmpLook = new T.Vector3();

  const CABIN = {
    kei:   { bh: 0.50, ch: 0.62, cabZ: -0.02, cabL: 0.58 },
    sedan: { bh: 0.56, ch: 0.56, cabZ: -0.14, cabL: 0.50 },
    van:   { bh: 0.66, ch: 0.86, cabZ: -0.04, cabL: 0.70 },
    truck: { bh: 0.70, ch: 0.80, cabZ:  0.24, cabL: 0.32 },
    bus:   { bh: 0.98, ch: 1.42, cabZ:  0.00, cabL: 0.88 },
  };

  const MAT = {
    cabin: new T.MeshStandardMaterial({ color: 0x24282d, roughness: 0.88, metalness: 0.02 }),
    seat: new T.MeshStandardMaterial({ color: 0x31363d, roughness: 0.94, metalness: 0.0 }),
    dash: new T.MeshStandardMaterial({ color: 0x15191d, roughness: 0.76, metalness: 0.08 }),
    trim: new T.MeshStandardMaterial({ color: 0x59616a, roughness: 0.52, metalness: 0.38 }),
    gauge: new T.MeshBasicMaterial({ color: 0xb9d7d0 }),
    glass: new T.MeshStandardMaterial({
      color: 0x78a5ba,
      roughness: 0.08,
      metalness: 0.02,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      depthTest: true,
      side: T.DoubleSide,
    }),
  };
  MAT.glass.name = 'gta_vehicle_glass';

  function dims(car) {
    const fp = car && car.userData && car.userData.footprint;
    return {
      w: fp && isFinite(fp.w) ? fp.w : 1.9,
      d: fp && isFinite(fp.d) ? fp.d : 4.2,
      h: car && car.userData && isFinite(car.userData.height) ? car.userData.height : 1.5,
    };
  }

  function cabinSpec(car) {
    const type = car && car.userData ? car.userData.type : 'sedan';
    return CABIN[type] || CABIN.sedan;
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

  function copyKeptTriangles(src, keepTri) {
    const non = src.index ? src.toNonIndexed() : src.clone();
    const attrs = non.attributes || {};
    const names = Object.keys(attrs);
    const pos = attrs.position;
    if (!pos || pos.count < 3) return non;

    const outData = {};
    for (let n = 0; n < names.length; n++) outData[names[n]] = [];

    const triCount = Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const cx = (pos.getX(i0) + pos.getX(i0 + 1) + pos.getX(i0 + 2)) / 3;
      const cy = (pos.getY(i0) + pos.getY(i0 + 1) + pos.getY(i0 + 2)) / 3;
      const cz = (pos.getZ(i0) + pos.getZ(i0 + 1) + pos.getZ(i0 + 2)) / 3;
      if (!keepTri(cx, cy, cz)) continue;

      for (let v = 0; v < 3; v++) {
        const idx = i0 + v;
        for (let n = 0; n < names.length; n++) {
          const name = names[n];
          const a = attrs[name];
          const dst = outData[name];
          const base = idx * a.itemSize;
          for (let c = 0; c < a.itemSize; c++) dst.push(a.array[base + c]);
        }
      }
    }

    const out = new T.BufferGeometry();
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const a = attrs[name];
      const Arr = a.array.constructor;
      out.setAttribute(name, new T.BufferAttribute(new Arr(outData[name]), a.itemSize, a.normalized));
    }
    if (!out.attributes.normal && out.attributes.position) out.computeVertexNormals();
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }

  function cutOpaqueCabin(car, bodyMesh) {
    if (!bodyMesh || !bodyMesh.geometry || bodyMesh.userData.gtaCabinCut) return;

    const d = dims(car);
    const p = cabinSpec(car);
    const bodyW = d.w / 1.08;
    const cabW = bodyW * 0.90;
    const cabLen = d.d * p.cabL;
    const cabCenterZ = d.d * p.cabZ;
    const wheelR = car.userData.wheelR || 0.34;
    const belt = wheelR * 0.46 + 0.10 + p.bh;
    const top = belt + p.ch;

    const sideMinX = cabW * 0.34;
    const sideMaxX = cabW * 0.555;
    const zHalf = cabLen * 0.54;
    const glassStart = belt + Math.max(0.045, p.ch * 0.04);
    const glassEnd = top - Math.max(0.07, p.ch * 0.10);

    const cut = copyKeptTriangles(bodyMesh.geometry, function (x, y, z) {
      if (y < glassStart || y > glassEnd) return true;
      const rz = z - cabCenterZ;
      if (Math.abs(rz) > zHalf) return true;

      const ax = Math.abs(x);
      const sideWindow = ax > sideMinX && ax < sideMaxX;
      const frontWindow = rz > cabLen * 0.30 && ax < cabW * 0.53;
      const rearWindow = rz < -cabLen * 0.30 && ax < cabW * 0.53;
      return !(sideWindow || frontWindow || rearWindow);
    });

    bodyMesh.geometry = cut;
    bodyMesh.userData.gtaCabinCut = true;
  }

  function addCabinFrame(car, parent) {
    if (car.userData.gtaCabinFrame) return;
    const d = dims(car);
    const p = cabinSpec(car);
    const bodyW = d.w / 1.08;
    const cabW = bodyW * 0.90;
    const cabLen = d.d * p.cabL;
    const cz = d.d * p.cabZ;
    const wheelR = car.userData.wheelR || 0.34;
    const belt = wheelR * 0.46 + 0.10 + p.bh;
    const top = belt + p.ch;
    const h = Math.max(0.28, top - belt);
    const frame = new T.Group();
    frame.name = 'gta02b-cabin-frame';
    const frameMat = new T.MeshStandardMaterial({
      color: car.userData.color === undefined ? 0x5f6b72 : car.userData.color,
      roughness: 0.58,
      metalness: 0.06,
    });

    const px = cabW * 0.47;
    const pz = cabLen * 0.43;
    const pillarW = Math.max(0.055, bodyW * 0.045);
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        frame.add(meshBox(pillarW, h * 0.88, pillarW, frameMat,
          sx * px, belt + h * 0.45, cz + sz * pz));
      }
    }
    frame.add(meshBox(cabW * 0.94, 0.065, 0.075, frameMat, 0, top - 0.08, cz + pz));
    frame.add(meshBox(cabW * 0.94, 0.065, 0.075, frameMat, 0, top - 0.08, cz - pz));
    parent.add(frame);
    car.userData.gtaCabinFrame = frame;
  }

  function upgradeCabinShell(car) {
    if (!car || !car.userData || car.userData.gtaCabinUpgraded) return;
    const shell = car.userData.body;
    if (!shell) return;

    let bodyMesh = null;
    const glassMeshes = [];
    for (let i = 0; i < shell.children.length; i++) {
      const o = shell.children[i];
      if (!o || !o.isMesh) continue;
      const mn = o.material && o.material.name ? o.material.name : '';
      if (mn.indexOf('window_') === 0) glassMeshes.push(o);
      else if (!bodyMesh && mn === 'dyn_paint') bodyMesh = o;
    }

    if (bodyMesh) cutOpaqueCabin(car, bodyMesh);
    for (let i = 0; i < glassMeshes.length; i++) {
      glassMeshes[i].material = MAT.glass;
      glassMeshes[i].renderOrder = 3;
      glassMeshes[i].castShadow = false;
    }
    car.userData.gtaCabinUpgraded = true;
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

    g.add(meshBox(cabinW, 0.07, cabinD, MAT.cabin, 0, floorY, -d.d * 0.02));
    g.add(meshBox(0.18, 0.16, cabinD * 0.72, MAT.dash, 0, floorY + 0.09, -d.d * 0.02));

    const dashY = Math.max(0.76, Math.min(1.03, d.h * 0.58));
    g.add(meshBox(cabinW * 0.96, 0.17, Math.max(0.18, d.d * 0.08), MAT.dash,
      0, dashY, d.d * 0.205));
    g.add(meshBox(0.38, 0.12, 0.08, MAT.cabin, driverX, dashY + 0.10, d.d * 0.166));

    for (let i = -1; i <= 1; i += 2) {
      const q = new T.Mesh(new T.CircleGeometry(0.055, 12), MAT.gauge);
      q.position.set(driverX + i * 0.075, dashY + 0.105, d.d * 0.122);
      q.rotation.x = -0.08;
      g.add(q);
    }

    const wheel = new T.Mesh(new T.TorusGeometry(0.17, 0.026, 6, 18), MAT.trim);
    wheel.position.set(driverX, dashY + 0.01, d.d * 0.085);
    wheel.rotation.x = -0.28;
    g.add(wheel);
    const spokeV = meshBox(0.035, 0.28, 0.035, MAT.trim, driverX, dashY + 0.01, d.d * 0.082);
    spokeV.rotation.z = 0.52;
    spokeV.rotation.x = -0.28;
    g.add(spokeV);

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

    addCabinFrame(car, g);

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

  function cloneVisual(src) {
    let dst;
    if (src.isMesh) {
      dst = new T.Mesh(src.geometry, src.material);
    } else if (src.isSprite) {
      dst = new T.Sprite(src.material);
    } else {
      dst = new T.Group();
    }
    dst.name = src.name || '';
    dst.position.copy(src.position);
    dst.quaternion.copy(src.quaternion);
    dst.scale.copy(src.scale);
    dst.visible = src.visible;
    dst.renderOrder = src.renderOrder || 0;
    for (let i = 0; i < src.children.length; i++) dst.add(cloneVisual(src.children[i]));
    return dst;
  }

  function makeDriverProxy(car, interior) {
    if (!car || !interior || !Game.player || !Game.player.o) return null;
    if (car.userData.gtaDriverProxy) return car.userData.gtaDriverProxy;

    const clone = cloneVisual(Game.player.o);
    clone.name = 'gta02b-driver';
    clone.visible = true;

    clone.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.type === 'CircleGeometry') o.visible = false;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });

    const seat = interior.userData.driverSeat;
    clone.scale.set(0.78, 0.67, 0.78);
    clone.position.set(seat.x, seat.y - 0.03, seat.z - 0.08);
    clone.rotation.set(0, 0, 0);
    car.add(clone);
    car.userData.gtaDriverProxy = clone;
    return clone;
  }

  function prepareCar(car) {
    upgradeCabinShell(car);
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
    console.log('[GTA-02B] real glazing + cabin + cockpit view ready');
  };

  B.toggleView = toggleView;

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
