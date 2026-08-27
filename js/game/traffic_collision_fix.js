/* =============================================================
   js/game/traffic_collision_fix.js — GTA-02C traffic follow safety

   Fixes closed-loop traffic headway without touching the legacy dynamics
   implementation. The original closed-route normalization maps vehicles
   ahead to a negative distance, so followers ignore them and overlap.

   This layer runs after dyn.traffic and:
   - computes correct forward distance on closed routes;
   - brakes a following car as it approaches the car ahead;
   - enforces a physical minimum centre-to-centre gap;
   - keeps the correction local to single-part road cars (not trams).
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Dynamics || !TOWN.Ticker || !TOWN.U) return;

  const U = TOWN.U;
  const Dyn = TOWN.Dynamics;
  const Fix = TOWN.TrafficCollisionFix = {
    version: 'GTA-02C.1',
    correctedFrames: 0,
  };

  const p = new T.Vector3();
  const tan = new T.Vector3();

  function carPart(m) {
    if (!m || !m.rt || !m.parts || m.parts.length !== 1) return null;
    const pt = m.parts[0];
    if (!pt || pt.joint || !pt.o || !pt.o.userData) return null;
    return pt.o.userData.kind === 'car' ? pt : null;
  }

  function carLength(m) {
    const pt = carPart(m);
    const fp = pt && pt.o.userData && pt.o.userData.footprint;
    return fp && isFinite(fp.d) ? fp.d : 4.2;
  }

  function laneOf(m) {
    const pt = carPart(m);
    return (m.lane || 0) + (pt && isFinite(pt.lane) ? pt.lane : 0);
  }

  function forwardGap(rear, front) {
    let ds = (front.s - rear.s) * rear.dir;
    if (rear.rt.closed) ds = U.mod(ds, rear.rt.len);
    return ds;
  }

  function setRouteS(m, s) {
    if (m.rt.closed) m.s = U.mod(s, m.rt.len);
    else m.s = U.clamp(s, 0, m.rt.len);
  }

  // Re-place the corrected single car immediately so the render for this
  // frame never shows two bodies occupying the same space.
  function placeCorrectedCar(m) {
    const pt = carPart(m);
    if (!pt) return;
    const rt = m.rt;
    let s = m.s;
    if (rt.closed) s = U.mod(s, rt.len);
    else s = U.clamp(s, 0, rt.len);
    const u = U.clamp(s / Math.max(0.001, rt.len), 0, 1);
    rt.curve.getPointAt(u, p);
    rt.curve.getTangentAt(u, tan);
    const yaw = Math.atan2(tan.x, tan.z);
    const lat = laneOf(m) * m.dir;
    pt.o.position.set(
      p.x + Math.cos(yaw) * lat,
      p.y + (m.y0 || 0),
      p.z - Math.sin(yaw) * lat
    );
    pt.o.rotation.y = yaw + (m.dir < 0 ? Math.PI : 0);
  }

  function updateTrafficSafety() {
    const systems = Dyn._systems;
    const list = systems && systems.VEH ? systems.VEH : null;
    if (!list || list.length < 2) return;

    let corrected = false;

    for (let i = 0; i < list.length; i++) {
      const rear = list[i];
      if (!carPart(rear)) continue;

      let front = null;
      let gap = Infinity;
      const rearLane = laneOf(rear);

      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const other = list[j];
        if (!carPart(other)) continue;
        if (other.rt !== rear.rt || other.dir !== rear.dir) continue;
        // Cars on a visibly separate parallel lane must not brake each other.
        if (Math.abs(laneOf(other) - rearLane) > 1.15) continue;

        const ds = forwardGap(rear, other);
        if (ds <= 0.05 || ds >= gap) continue;
        gap = ds;
        front = other;
      }

      if (!front) continue;

      const minGap = (carLength(rear) + carLength(front)) * 0.5 + 0.55;
      const brakeGap = minGap + 4.4;
      const frontVel = Math.max(0, isFinite(front.vel) ? front.vel : 0);

      // Smooth approach: farther away permits the rear car's normal cruise
      // speed; near the bumper it must converge to the front car's speed.
      if (gap < brakeGap) {
        const t = U.clamp((gap - minGap) / Math.max(0.01, brakeGap - minGap), 0, 1);
        const cruise = Math.max(0, isFinite(rear.spd) ? rear.spd : rear.vel || 0);
        const target = frontVel + Math.max(0, cruise - frontVel) * t;
        rear.vel = Math.min(isFinite(rear.vel) ? rear.vel : target, target);
      }

      // Hard non-overlap gate. This is intentionally centre-distance based on
      // the actual generated car lengths, not one fixed sedan radius.
      if (gap < minGap) {
        const penetration = minGap - gap;
        setRouteS(rear, rear.s - penetration * rear.dir);
        rear.vel = Math.min(isFinite(rear.vel) ? rear.vel : frontVel, frontVel);
        placeCorrectedCar(rear);
        corrected = true;
      }
    }

    if (corrected) Fix.correctedFrames++;
  }

  TOWN.Ticker.add(updateTrafficSafety, 'gta02c.trafficCollision');
  console.log('[GTA-02C] traffic follow collision fix ready');
})(window);
