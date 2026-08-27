/* =============================================================
   js/game/gta11_traffic_collision.js — GTA-11 unified traffic blockers

   Ambient route cars used to follow their spline regardless of buildings,
   props, parked cars or the player's currently controlled car. This layer
   runs after legacy traffic + GTA-02C and makes single-part road cars obey
   the same physical world that the player vehicle sees.

   No mesh raycasts. All tests are lightweight 2D OBB checks against
   TOWN.Colliders / CollisionV1 solids and other car footprints.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Dynamics || !TOWN.Ticker || !TOWN.U) return;

  const U = TOWN.U;
  const Dyn = TOWN.Dynamics;
  const V = TOWN.Vehicles;

  const G = TOWN.GTA11TrafficCollision = {
    version: 'GTA-11.1',
    correctedFrames: 0,
    staticStops: 0,
    playerStops: 0,
    crossTrafficStops: 0,
  };

  const p = new T.Vector3();
  const tan = new T.Vector3();
  const lastSafe = new WeakMap();

  function carPart(m) {
    if (!m || !m.rt || !m.parts || m.parts.length !== 1) return null;
    const pt = m.parts[0];
    if (!pt || pt.joint || !pt.o || !pt.o.userData) return null;
    return pt.o.userData.kind === 'car' ? pt : null;
  }

  function footprint(car) {
    const fp = car && car.userData && car.userData.footprint;
    return {
      w: fp && Number.isFinite(fp.w) ? fp.w : 1.8,
      d: fp && Number.isFinite(fp.d) ? fp.d : 4.2,
    };
  }

  function laneOf(m) {
    const pt = carPart(m);
    return (m.lane || 0) + (pt && Number.isFinite(pt.lane) ? pt.lane : 0);
  }

  function routeS(m, s) {
    if (m.rt.closed) return U.mod(s, m.rt.len);
    return U.clamp(s, 0, m.rt.len);
  }

  function poseAt(m, s, out) {
    const pt = carPart(m);
    if (!pt) return null;
    const rt = m.rt;
    s = routeS(m, s);
    const u = U.clamp(s / Math.max(0.001, rt.len), 0, 1);
    rt.curve.getPointAt(u, p);
    rt.curve.getTangentAt(u, tan);
    const yaw = Math.atan2(tan.x, tan.z);
    const lat = laneOf(m) * m.dir;
    const fp = footprint(pt.o);
    out = out || {};
    out.x = p.x + Math.cos(yaw) * lat;
    out.z = p.z - Math.sin(yaw) * lat;
    out.y = p.y + (m.y0 || 0);
    out.rot = yaw + (m.dir < 0 ? Math.PI : 0);
    out.w = Math.max(1.0, fp.w * 0.90);
    out.d = Math.max(2.0, fp.d * 0.92);
    out.r = Math.hypot(out.w, out.d) * 0.5;
    out.s = s;
    return out;
  }

  function objectObb(car, out) {
    if (!car) return null;
    const fp = footprint(car);
    out = out || {};
    out.x = car.position.x;
    out.z = car.position.z;
    out.rot = car.rotation.y || 0;
    out.w = Math.max(1.0, fp.w * 0.90);
    out.d = Math.max(2.0, fp.d * 0.92);
    out.r = Math.hypot(out.w, out.d) * 0.5;
    return out;
  }

  function axes(rot) {
    const c = Math.cos(rot || 0), s = Math.sin(rot || 0);
    return [[c, -s], [s, c]];
  }

  function obbOverlap(a, b, pad) {
    if (!a || !b) return false;
    pad = pad || 0;
    const dx = b.x - a.x, dz = b.z - a.z;
    const rr = (a.r || Math.hypot(a.w, a.d) * 0.5) +
      (b.r || Math.hypot(b.w, b.d) * 0.5) + pad;
    if (dx * dx + dz * dz > rr * rr) return false;

    const A = axes(a.rot), B = axes(b.rot);
    const test = [A[0], A[1], B[0], B[1]];
    const aw = a.w * 0.5 + pad * 0.5, ad = a.d * 0.5 + pad * 0.5;
    const bw = b.w * 0.5 + pad * 0.5, bd = b.d * 0.5 + pad * 0.5;
    for (let i = 0; i < 4; i++) {
      const ax = test[i];
      const ea = Math.abs(ax[0] * A[0][0] + ax[1] * A[0][1]) * aw +
        Math.abs(ax[0] * A[1][0] + ax[1] * A[1][1]) * ad;
      const eb = Math.abs(ax[0] * B[0][0] + ax[1] * B[0][1]) * bw +
        Math.abs(ax[0] * B[1][0] + ax[1] * B[1][1]) * bd;
      if (Math.abs(dx * ax[0] + dz * ax[1]) > ea + eb) return false;
    }
    return true;
  }

  function colliderObb(c, out) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z) ||
        !Number.isFinite(c.w) || !Number.isFinite(c.d)) return null;
    out = out || {};
    out.x = c.x; out.z = c.z; out.w = c.w; out.d = c.d; out.rot = c.rot || 0;
    out.r = c.r || Math.hypot(c.w, c.d) * 0.5;
    return out;
  }

  function hitsStatic(obb) {
    const cols = TOWN.Colliders || [];
    const b = {};
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!colliderObb(c, b)) continue;
      if (obbOverlap(obb, b, 0.12)) return c;
    }
    return null;
  }

  function playerVehicleObb() {
    if (!V || !V.STATES || V.state !== V.STATES.DRIVING || !V.current || !V.current.car) return null;
    return objectObb(V.current.car, {});
  }

  function placeAt(m, pose) {
    const pt = carPart(m);
    if (!pt || !pose) return;
    m.s = routeS(m, pose.s);
    pt.o.position.set(pose.x, pose.y, pose.z);
    pt.o.rotation.y = pose.rot;
  }

  function blocked(obb, playerObb, occupied) {
    const solid = hitsStatic(obb);
    if (solid) return { type: 'static', hit: solid };
    if (playerObb && obbOverlap(obb, playerObb, 0.28)) return { type: 'player', hit: playerObb };
    for (let i = 0; i < occupied.length; i++) {
      if (obbOverlap(obb, occupied[i], 0.18)) return { type: 'traffic', hit: occupied[i] };
    }
    return null;
  }

  function rewindToClear(m, playerObb, occupied) {
    const safe = lastSafe.get(m);
    const test = {};
    if (Number.isFinite(safe)) {
      poseAt(m, safe, test);
      if (!blocked(test, playerObb, occupied)) {
        placeAt(m, test);
        m.vel = 0;
        return test;
      }
    }

    // Search backwards along the lane instead of teleporting sideways. This
    // preserves the authored traffic route and makes the car stop before the
    // obstacle just like the player's vehicle would.
    for (let back = 0.45; back <= 7.2; back += 0.45) {
      poseAt(m, m.s - back * m.dir, test);
      if (blocked(test, playerObb, occupied)) continue;
      placeAt(m, test);
      m.vel = 0;
      lastSafe.set(m, test.s);
      return test;
    }

    // Fail closed: do not intentionally advance through geometry.
    m.vel = 0;
    return poseAt(m, m.s, test);
  }

  function updateTrafficCollision() {
    const systems = Dyn._systems;
    const list = systems && systems.VEH ? systems.VEH : null;
    if (!list || !list.length) return;

    const playerObb = playerVehicleObb();
    const occupied = [];
    let corrected = false;

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!carPart(m)) continue;

      const now = poseAt(m, m.s, {});
      let hit = blocked(now, playerObb, occupied);

      if (hit) {
        if (hit.type === 'static') G.staticStops++;
        else if (hit.type === 'player') G.playerStops++;
        else G.crossTrafficStops++;
        const fixed = rewindToClear(m, playerObb, occupied);
        occupied.push({ x: fixed.x, z: fixed.z, rot: fixed.rot, w: fixed.w, d: fixed.d, r: fixed.r });
        corrected = true;
        continue;
      }

      // Look ahead and brake before contact. This is especially important for
      // the player's car, because the player may be stationary across a lane.
      const speed = Math.max(0, Number.isFinite(m.vel) ? Math.abs(m.vel) : 0);
      const look = Math.min(3.6, 0.9 + speed * 0.42);
      const ahead = poseAt(m, m.s + look * m.dir, {});
      const aheadHit = blocked(ahead, playerObb, occupied);
      if (aheadHit) m.vel = Math.min(Number.isFinite(m.vel) ? m.vel : 0.35, 0.35);

      lastSafe.set(m, now.s);
      occupied.push({ x: now.x, z: now.z, rot: now.rot, w: now.w, d: now.d, r: now.r });
    }

    if (corrected) G.correctedFrames++;
  }

  TOWN.Ticker.add(updateTrafficCollision, 'gta11.trafficCollision');
  console.log('[GTA-11] unified ambient traffic collision ready');
})(window);
