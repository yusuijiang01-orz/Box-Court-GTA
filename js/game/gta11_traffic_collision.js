/* =============================================================
   js/game/gta11_traffic_collision.js — GTA-11B de-jammed ambient traffic

   Same-route following is already owned by GTA-02C. This layer therefore:
   - blocks ambient cars against real static solids / parked / player vehicle;
   - gives deterministic right-of-way only to CROSS-route cars at junctions;
   - never makes every route car mutually block every other route car;
   - includes a rare forward recovery gate so one bad authored obstacle cannot
     freeze an entire closed-loop convoy forever.

   No mesh raycasts. All tests are lightweight 2D OBB checks.
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
    version: 'GTA-11B.1',
    correctedFrames: 0,
    staticStops: 0,
    playerStops: 0,
    crossTrafficYields: 0,
    recoveries: 0,
  };

  const p = new T.Vector3();
  const tan = new T.Vector3();
  const lastSafe = new WeakMap();
  const blockedSince = new WeakMap();

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
    out.w = Math.max(0.95, fp.w * 0.82);
    out.d = Math.max(1.85, fp.d * 0.80);
    out.r = Math.hypot(out.w, out.d) * 0.5;
    out.s = s;
    out.route = m.rt;
    return out;
  }

  function objectObb(car, out) {
    if (!car) return null;
    const fp = footprint(car);
    out = out || {};
    out.x = car.position.x;
    out.z = car.position.z;
    out.rot = car.rotation.y || 0;
    out.w = Math.max(1.05, fp.w * 0.90);
    out.d = Math.max(2.0, fp.d * 0.90);
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
    const parked = c.source === 'GTA-02' || c.name === 'parkedVehicle';
    const k = parked ? 0.96 : 0.88;
    out.x = c.x; out.z = c.z;
    out.w = Math.max(0.2, c.w * k);
    out.d = Math.max(0.2, c.d * k);
    out.rot = c.rot || 0;
    out.r = Math.hypot(out.w, out.d) * 0.5;
    return out;
  }

  function hitsStatic(obb) {
    const cols = TOWN.Colliders || [];
    const b = {};
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!colliderObb(c, b)) continue;
      if (obbOverlap(obb, b, 0.05)) return c;
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

  function crossHit(obb, route, occupied) {
    for (let i = 0; i < occupied.length; i++) {
      const o = occupied[i];
      if (!o || o.route === route) continue;
      if (obbOverlap(obb, o, 0.04)) return o;
    }
    return null;
  }

  function blocked(obb, playerObb, occupied, route) {
    const solid = hitsStatic(obb);
    if (solid) return { type: 'static', hit: solid };
    if (playerObb && obbOverlap(obb, playerObb, 0.18)) return { type: 'player', hit: playerObb };
    const cross = crossHit(obb, route, occupied);
    if (cross) return { type: 'cross', hit: cross };
    return null;
  }

  function rewindToClear(m, playerObb, occupied) {
    const safe = lastSafe.get(m);
    const test = {};
    if (Number.isFinite(safe)) {
      poseAt(m, safe, test);
      if (!blocked(test, playerObb, occupied, m.rt)) {
        placeAt(m, test);
        m.vel = Math.min(Number.isFinite(m.vel) ? m.vel : 0.2, 0.20);
        return test;
      }
    }

    for (let back = 0.35; back <= 3.5; back += 0.35) {
      poseAt(m, m.s - back * m.dir, test);
      if (blocked(test, playerObb, occupied, m.rt)) continue;
      placeAt(m, test);
      m.vel = 0.18;
      lastSafe.set(m, test.s);
      return test;
    }
    m.vel = 0.12;
    return poseAt(m, m.s, test);
  }

  function forwardRecover(m, playerObb, occupied) {
    const test = {};
    for (let fwd = 2.5; fwd <= 11.0; fwd += 0.5) {
      poseAt(m, m.s + fwd * m.dir, test);
      if (blocked(test, playerObb, occupied, m.rt)) continue;
      placeAt(m, test);
      m.vel = Math.max(0.45, Math.min(Number(m.spd) || 1.0, 1.0));
      lastSafe.set(m, test.s);
      blockedSince.delete(m);
      G.recoveries++;
      return test;
    }
    return null;
  }

  function markBlocked(m, et) {
    if (!blockedSince.has(m)) blockedSince.set(m, et);
    return et - blockedSince.get(m);
  }

  function clearBlocked(m) {
    blockedSince.delete(m);
  }

  function updateTrafficCollision(dt, et) {
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
      let hit = blocked(now, playerObb, occupied, m.rt);

      if (hit) {
        const age = markBlocked(m, Number(et) || 0);
        if (hit.type === 'static') G.staticStops++;
        else if (hit.type === 'player') G.playerStops++;
        else G.crossTrafficYields++;

        let fixed;
        if (hit.type === 'cross') {
          m.vel = Math.min(Number.isFinite(m.vel) ? m.vel : 0.22, 0.22);
          fixed = rewindToClear(m, playerObb, occupied);
        } else {
          fixed = rewindToClear(m, playerObb, occupied);
          if (age > 4.5) fixed = forwardRecover(m, playerObb, occupied) || fixed;
        }
        occupied.push({ x: fixed.x, z: fixed.z, rot: fixed.rot, w: fixed.w, d: fixed.d,
          r: fixed.r, route: m.rt });
        corrected = true;
        continue;
      }

      const speed = Math.max(0, Number.isFinite(m.vel) ? Math.abs(m.vel) : 0);
      const look = Math.min(3.0, 0.75 + speed * 0.32);
      const ahead = poseAt(m, m.s + look * m.dir, {});
      const aheadHit = blocked(ahead, playerObb, occupied, m.rt);
      if (aheadHit) {
        markBlocked(m, Number(et) || 0);
        if (aheadHit.type === 'cross') {
          G.crossTrafficYields++;
          m.vel = Math.min(Number.isFinite(m.vel) ? m.vel : 0.32, 0.32);
        } else {
          m.vel = Math.min(Number.isFinite(m.vel) ? m.vel : 0.38, 0.38);
        }
      } else {
        clearBlocked(m);
        lastSafe.set(m, now.s);
      }

      occupied.push({ x: now.x, z: now.z, rot: now.rot, w: now.w, d: now.d,
        r: now.r, route: m.rt });
    }

    if (corrected) G.correctedFrames++;
  }

  TOWN.Ticker.add(updateTrafficCollision, 'gta11.trafficCollision');
  console.log('[GTA-11B] de-jammed ambient traffic collision ready');
})(window);
