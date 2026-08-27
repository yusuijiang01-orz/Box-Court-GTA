/* =============================================================
   js/game/player.js — TOWN.Player + TOWN.FollowCam

   Turns one of the town's residents into a controllable character.
   Movement is camera-relative; the terrain is sampled with
   TOWN.Island.sample() so the figure always stands on the ground
   and refuses to walk into the sea. Limb animation reuses the same
   swing math as the crowd ticker (dynamics.js stepWalk), so the
   hero walks exactly like the NPCs.
   ============================================================= */
(function (global) {
  'use strict';
  const T = global.THREE;
  const TOWN = global.TOWN;
  const U = TOWN.U, P = TOWN.Palette;

  const Island = TOWN.Island;
  const TAU = U.TAU, PI = Math.PI;

  // reusable scratch (never allocate per frame)
  const _fwd = new T.Vector3(), _right = new T.Vector3(), _mv = new T.Vector3();
  const _camPos = new T.Vector3(), _look = new T.Vector3();
  const _groundRay = new T.Raycaster();
  const _groundOrigin = new T.Vector3();
  const _groundDown = new T.Vector3(0, -1, 0);
  const _groundOffsets = [                         // 5-point cross (centre + 4 cardinals)
    [0, 0],
    [ 0.18, 0], [-0.18, 0],
    [0,  0.18], [0, -0.18],
  ];
  const GROUND_RAY_LEN = 6.0;                    // how far down we look from "head + 2 m"
  const MAX_STEP_HEIGHT = 0.285;                 // single riser — taller = wall, block it

  /* ===========================================================
     TOWN.Player — build + per-frame update
     =========================================================== */
  const Player = TOWN.Player = {};

  /**
   * build(opts) -> player state object.
   * opts: { seed, scale, x, z }
   * Spawns a distinct, slightly taller hero at (x,z) on the terrain.
   */
  Player.build = function (opts) {
    opts = opts || {};
    const D = TOWN.Dynamics;
    const seed = opts.seed || 909090;
    const scale = opts.scale === undefined ? 1.06 : opts.scale; // a touch taller than the townsfolk
    const r = U.rng(seed);
    const p = D.buildPerson(r, scale, false);

    const g = p.o;
    g.userData.limbs = p.limbs;
    g.userData.torso = p.torso;
    g.userData.hip = p.hip;
    g.userData.scale = scale;
    g.name = 'player';
    TOWN.markDynamic(g);

    // a soft contact-shadow blob under the feet (cheap fake)
    const blob = new T.Mesh(
      new T.CircleGeometry(0.55, 20),
      new T.MeshBasicMaterial({ color: 0x100804, transparent: true, opacity: 0.26, depthWrite: false })
    );
    blob.rotation.x = -PI / 2;
    blob.position.y = 0.02;
    g.add(blob);
    g.userData.shadowBlob = blob;

    // place on terrain
    const sx = opts.x === undefined ? 4 : opts.x;
    const sz = opts.z === undefined ? -6 : opts.z;
    const gy = Island.heightAt(sx, sz);
    g.position.set(sx, gy, sz);

    const st = {
      o: g,
      limbs: p.limbs,          // [legL, legR, armL, armR]
      torso: p.torso,
      hip: p.hip,
      scale: scale,
      // physics
      vel: new T.Vector3(0, 0, 0),
      vy: 0,
      onGround: true,
      // locomotion
      yaw: 0,                  // facing (radians)
      moveYaw: 0,              // last movement yaw, for camera follow
      speed: 0,                // current horizontal speed (m/s)
      walkPhase: r() * TAU,     // leg-swing phase
      // flags
      running: false,
      attacking: 0,            // attack timer (s, >0 while swinging)
      attackHit: false,        // has this swing already applied knockback
      jumpQueued: 0,           // small buffering window
      // tuning
      walkSpeed: 2.6,
      runSpeed: 5.6,
      turnRate: 11,            // how fast yaw eases toward target
      gravity: 16,
      jumpVel: 6.2,
      height: 1.72 * scale,    // eye height
      radius: 0.42,            // collision capsule radius (m)
      // ground-sample anti-fly guard: if the raycast system keeps pushing
      // the hero UP for many consecutive frames we assume it's hitting
      // stray balconies / lamp posts and disable raycast grounding for a
      // short while, falling back to pure Island.sample.
      _gg: {
        badUntil: 0,           // ms timestamp until we force island fallback
        riseStreak: 0,         // consecutive FRAMES with a suspicious rise
        sawRiseThisFrame: false, // per-call helper -> true once a FRAME
        frameSeq: 0,           // running 64-bit frame counter
        floatSince: 0,         // ms timestamp when we first noticed hover
        lastGoodY: gy,         // last foot Y we believed was truly on ground
        lastGoodT: 0,          // ...and when it happened
      },
      // onscreen anti-fly HUD (press V to toggle)
      _dbg: { show: false, el: null, lastSampled: null },
    };

    st.yaw = st.moveYaw = g.rotation.y = 0;
    return st;
  };

  /** sampleGroundY(x, z, baseY) — height under foot (x,z) using either the
    *   staged walkable-mesh raycast (stairs / rooftops / decks) or falling back
    *   to Island.sample for natural terrain.  Returns {y: Number, hit: bool}.
    *
    *   A single downward ray is cast from (x, baseY+2.2, z) of length
    *   GROUND_RAY_LEN ≈ 6 m.  We keep ONLY hits that look like walkable
    *   surfaces: the world-space face normal must point up (normal.y ≥ 0.6)
    *   and the hit point must sit between the ray origin and a generous
    *   ceiling below it.  Among those we pick the NEAREST (smallest
    *   distance), i.e. the first upward-facing surface you would hit while
    *   falling.  This is the canonical "what am I standing on" query — the
    *   earlier max-point-y version is WRONG because a vertical wall can
    *   intersect the ray at y = 5 m (the top of the wall) and send the hero
    *   flying to the roof.
    */
  const _tmpMatNormal = new T.Matrix3();
  const _tmpNormal = new T.Vector3();
  function sampleGroundY(x, z, baseY) {
    const meshes = Player.groundMeshes;
    const rayTop = baseY + 2.2;
    const rayBottomClamp = rayTop - 20.0;       // hard sanity floor (below world)
    if (meshes && meshes.length) {
      _groundOrigin.set(x, rayTop, z);
      _groundRay.set(_groundOrigin, _groundDown, 0, GROUND_RAY_LEN);
      const hits = _groundRay.intersectObjects(meshes, false);
      if (hits && hits.length) {
        let best = null;
        for (let i = 0; i < hits.length; i++) {
          const h = hits[i];
          if (!h || !h.face) continue;
          if (h.distance < 0) continue;          // behind the ray origin (impossible downward)
          const py = h.point.y;
          if (py > rayTop + 1e-3) continue;      // can't be above the ray's start
          if (py < rayBottomClamp) continue;     // below any walkable surface
          // Sanity: the point we hit can't be way above the hero's feet.
          // A generous 2.5 m ceiling lets the hero climb a full flight of
          // stairs over multiple frames without being rejected; a single
          // frame still can't jump more than MAX_STEP_HEIGHT (see below).
          if (py > baseY + 2.5) continue;

          // Walkable-surface check: transform the triangle's local normal
          // into world space and require its +Y component ≥ 0.6 (faces up
          // within ~53°, i.e. slope ≤ 1:1).  This weeds out walls, windows,
          // the sides of steps, building facades etc.
          _tmpMatNormal.getNormalMatrix(h.object.matrixWorld);
          _tmpNormal.copy(h.face.normal).applyMatrix3(_tmpMatNormal);
          if (_tmpNormal.y < 0.60) continue;

          if (best === null || h.distance < best.distance) best = h;
        }
        if (best !== null && isFinite(best.point.y)) {
          return { y: best.point.y, hit: true, face: best.face, obj: best.object.name || '' };
        }
      }
    }
    const island = Island.sample(x, z);
    return { y: island.y, hit: island.land, face: null, obj: 'island' };
  }
  function sampleGroundCross(x, z, baseY) {
    // Collect the 5 probe results.  Previously we simply took the max which
    // lets a SINGLE stray probe that glimpsed a rooftop / balcony edge yank
    // the hero upward 0.285 m every frame until they float to the sky.
    // Now we use the MEDIAN of the 5 values: robust to one or two outliers
    // while still preferring the higher tread when crossing a step edge.
    const ys = new Array(_groundOffsets.length);
    let hits = 0;
    for (let i = 0; i < _groundOffsets.length; i++) {
      const ox = x + _groundOffsets[i][0];
      const oz = z + _groundOffsets[i][1];
      const r = sampleGroundY(ox, oz, baseY);
      ys[i] = r.y;
      if (r.hit) hits++;
    }
    if (hits === 0) return { y: ys[0], hit: false, obj: 'miss' };
    // Partial insertion sort, then pick index floor(N/2) = the median.
    // N is tiny (5) so brute force is fine and zero-alloc.
    for (let i = 1; i < ys.length; i++) {
      const v = ys[i]; let j = i - 1;
      while (j >= 0 && ys[j] > v) { ys[j + 1] = ys[j]; j--; }
      ys[j + 1] = v;
    }
    const med = ys[(ys.length - 1) >> 1];
    // Tread-edge boost: if the MEDIAN is close to a MAX value within a
    // single step riser, take the MAX.  3 of 5 probes on the upper tread
    // and 2 on the lower -> median is the upper tread (correct).  Only
    // when 4 probes are low and 1 probe is high (the classic stray
    // balcony case) do we stick to the median and ignore the high probe.
    let outY = med;
    const maxY = ys[ys.length - 1];
    if (maxY - med <= MAX_STEP_HEIGHT) outY = maxY;
    return { y: outY, hit: true, obj: 'med5' };
  }

  /** guardedGround(st, x, z, baseY, dt) — wraps sampleGroundCross with a
    *   multi-frame anti-fly tripwire.  If the raycast keeps proposing a rise
    *   above the hero's feet for ~10 consecutive FRAMES we trust it less
    *   than the island shape and fall back to Island.sample for ~1.4 s,
    *   giving the hero time to fall back to real terrain.
    *   IMPORTANT: guardedGround is called 3×/frame; the RISE-STREAK counter
    *   increments at most ONCE per frame (see applyMove prologue).
    */
  function guardedGround(st, x, z, baseY, dt) {
    const gg = st._gg;
    const now = Date.now ? Date.now() : 0;
    const guard = gg && now > 0;
    if (guard && now < gg.badUntil) {
      // Tripwire active — don't believe raycasts at all this call.
      const isl = Island.sample(x, z);
      return { y: isl.y, hit: isl.land, obj: 'guarded_island' };
    }
    const g = sampleGroundCross(x, z, baseY);
    if (guard) {
      const rise = g.y - baseY;
      // Only treat positive rises (hero being pushed UP) as suspicious;
      // falling is fine.  We used to gate on st.onGround as well but the
      // gravity clamp path sets onGround=false whenever a rise exceeds
      // MAX_STEP_HEIGHT — which is exactly the case when raycast glitches
      // keep pumping the hero UP 0.285 m / frame.  So onGround=false is
      // actually the SIGNATURE of the glitch we're hunting, not a reason
      // to skip counting.  Real jumps (vy>>0) produce at most 1 single
      // frame of rise>0.10 while still near the ground (the rest of the
      // arc the foot is ABOVE ground and sampleGroundCross returns a
      // surface LOWER than baseY -> rise negative).  So no onGround gate.
      if (rise > 0.10 && !gg.sawRiseThisFrame) {
        gg.sawRiseThisFrame = true;
        gg.riseStreak++;
      }
      if (gg.riseStreak >= 6) {
        // 100 ms at 60 fps — ~1.7 m of glitch climb (6 × 0.285)
        gg.badUntil = now + 1400;
        gg.riseStreak = 0;
        gg.floatSince = 0;
        const isl = Island.sample(x, z);
        return { y: isl.y, hit: isl.land, obj: 'tripped_island' };
      }
    }
    return g;
  }

  /** applyMove(st, input, camera, dt) — read input + camera, move the body. */
  function applyMove(st, input, camera, dt) {
    // ---- on-screen anti-fly HUD (press V) ---- consume toggle edge once
    if (st._dbg && input && input.toggleDebug) {
      input.toggleDebug = false;
      st._dbg.show = !st._dbg.show;
      if (st._dbg.show && !st._dbg.el) {
        const el = document.createElement('div');
        el.className = 'hud';
        el.style.cssText = [
          'position:fixed; left:8px; top:64px; z-index:200;',
          'background:rgba(0,0,0,0.55); color:#fff; padding:8px 10px;',
          'font: 12px/1.5 ui-monospace,Menlo,Consolas,monospace;',
          'border-radius:6px; pointer-events:none; white-space:pre;'
        ].join('');
        document.body.appendChild(el);
        st._dbg.el = el;
      }
      if (st._dbg.el) st._dbg.el.style.display = st._dbg.show ? '' : 'none';
    }

    // bump the anti-fly guard's frame counter: one "rise count budget" per
    // actual frame, even though guardedGround is called 3 times per frame
    // (stepUp / gravity / post-collision).  Without this the 2nd/3rd calls
    // would subtract streak faster than the 1st could add it (it was +1-4 =
    // -3 / frame) and we'd never trip the wire.
    if (st._gg) {
      st._gg.frameSeq++;
      st._gg.sawRiseThisFrame = false;
    }
    // input.move = {x, y} where y>0 = forward (up on stick)
    let mx = 0, mz = 0;
    if (input.move) { mx = input.move.x; mz = input.move.y; }
    const mag = Math.min(1, Math.hypot(mx, mz));

    // Camera-relative basis on the XZ plane.  SINGLE SOURCE OF TRUTH:
    // camera.getWorldDirection() — Three.js' own forward vector (where the
    // camera is actually looking).  So W/A/S/D always match exactly what you
    // see on screen.  No more hand-tuned sin/cos sign guessing.
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    const fl = _fwd.length();
    if (fl < 1e-4) _fwd.set(0, 0, -1); else _fwd.multiplyScalar(1 / fl);
    // Right vector: rotate the flat forward 90° COUNTER-CLOCKWISE around +Y
    // when looking DOWN from above.  In THREE.js right-handed terms this is
    // equivalent to  Right = (-fwd.z, 0, fwd.x).
    // Verify: if fwd = (0,0,-1) [camera default, looking into screen -Z],
    // then Right = (+1, 0, 0) = +X = screen's right side.  ✓
    _right.set(-_fwd.z, 0, _fwd.x);

    _mv.set(0, 0, 0);
    _mv.addScaledVector(_fwd, mz);
    _mv.addScaledVector(_right, mx);
    const len = Math.hypot(_mv.x, _mv.z);
    if (len > 1e-4) { _mv.x /= len; _mv.z /= len; }

    const running = !!input.run && mag > 0.05;
    const targetSpeed = (running ? st.runSpeed : st.walkSpeed) * mag;
    st.running = running;

    // ease speed toward target
    st.speed = U.damp(st.speed, targetSpeed, 10, dt);

    // horizontal motion
    const dx = _mv.x * st.speed * dt;
    const dz = _mv.z * st.speed * dt;

    // propose new position, but block water (keep the hero on land)
    const oldX = st.o.position.x, oldZ = st.o.position.z;
    const nx = oldX + dx;
    const nz = oldZ + dz;
    const samp = Island.sample(nx, nz);
    let allowX = nx, allowZ = nz;
    if (!samp.land) {
      // try axis-separated moves so sliding along a shore still works
      const sx2 = Island.sample(nx, oldZ).land;
      const sz2 = Island.sample(oldX, nz).land;
      allowX = sx2 ? nx : oldX;
      allowZ = sz2 ? nz : oldZ;
      // if both blocked, stay put
      if (!sx2 && !sz2) { allowX = oldX; allowZ = oldZ; }
    }
    // Stair / step-up test: look up the ground height at the *candidate*
    // landing position using the staged walkable-mesh raycast.  If the new
    // ground is taller than MAX_STEP_HEIGHT above the player's feet we treat
    // it as a WALL and roll back the horizontal component that caused it.
    const feetY = st.o.position.y;
    const targetGrnd = guardedGround(st, allowX, allowZ, feetY, dt);
    const stepUp = targetGrnd.y - feetY;
    if (stepUp > MAX_STEP_HEIGHT) {
      // Too tall — treat as a wall.  Try each axis independently so we can
      // still slide sideways along the wall instead of stopping cold.
      let tryX = oldX, tryZ = oldZ;
      const grndX = sampleGroundCross(allowX, oldZ, feetY);
      const grndZ = sampleGroundCross(oldX, allowZ, feetY);
      const canX = (grndX.y - feetY) <= MAX_STEP_HEIGHT;
      const canZ = (grndZ.y - feetY) <= MAX_STEP_HEIGHT;
      if (canX && canZ) { tryX = allowX; tryZ = oldZ; }           // arbitrary but consistent
      else if (canX) { tryX = allowX; tryZ = oldZ; }
      else if (canZ) { tryX = oldX; tryZ = allowZ; }
      else          { tryX = oldX; tryZ = oldZ; }
      allowX = tryX; allowZ = tryZ;
    }
    st.o.position.x = allowX;
    st.o.position.z = allowZ;

    // face the movement direction (or keep facing forward when idle)
    if (mag > 0.08) {
      const tgtYaw = Math.atan2(_mv.x, _mv.z);
      st.moveYaw = tgtYaw;
      // ease yaw toward target
      const d = U.angleDelta(st.yaw, tgtYaw);
      st.yaw += U.clamp(d, -st.turnRate * dt, st.turnRate * dt);
    }

    // gravity + jump
    if (input.jumpPressed && st.onGround) {
      st.vy = st.jumpVel;
      st.onGround = false;
    }
    const preGravFootY = st.o.position.y;
    st.vy -= st.gravity * dt;

    // Grounding: use the staged walkable-mesh raycast so stairs, rooftops,
    // decks and piers actually support the player (Island.sample only knows
    // natural terrain).  We then compare the new foot height against this
    // ground, and if airborne we integrate vy; if grounded we snap and zero.
    const curGround = guardedGround(st, st.o.position.x, st.o.position.z, preGravFootY, dt);
    let gy = curGround.y;
    // If raycast hit no walkable surface and this isn't land (open sea),
    // don't force the player to dive — keep them roughly where they hover.
    if (!curGround.hit) {
      const isl = Island.sample(st.o.position.x, st.o.position.z);
      if (!isl.land) gy = Math.max(gy, preGravFootY);
    }
    const footAfter = preGravFootY + st.vy * dt;
    if (footAfter <= gy + 1e-4) {
      const rise = gy - preGravFootY;          // how much we'd rise if snapped
      if (rise > MAX_STEP_HEIGHT + 1e-3) {
        // Suspiciously tall step — the ray likely hit the top of a wall.
        // Clamp the upward motion to one real riser per frame so the hero
        // can't teleport to a roof even if raycasting glitches out briefly.
        st.o.position.y = preGravFootY + MAX_STEP_HEIGHT;
        st.vy = 0;
        st.onGround = false;                  // still airborne in spirit
      } else {
        st.o.position.y = gy;
        st.vy = 0;
        st.onGround = true;
      }
    } else {
      st.o.position.y = footAfter;
      st.onGround = false;
    }

    resolveCollisions(st);

    // After OBB push-out (which only shifts XZ) re-ground so the player
    // doesn't hover 5 cm above a stair tread after being nudged sideways.
    const prePostFootY = st.o.position.y;
    const postGrnd = guardedGround(st, st.o.position.x, st.o.position.z, prePostFootY, dt);
    if (postGrnd.hit && prePostFootY <= postGrnd.y + 1e-3) {
      const rise = postGrnd.y - prePostFootY;
      if (rise > MAX_STEP_HEIGHT + 1e-3) {
        st.o.position.y = prePostFootY + MAX_STEP_HEIGHT;
        if (st.vy > 0) st.vy = 0;
        st.onGround = false;
      } else {
        st.o.position.y = postGrnd.y;
        if (!st.onGround) st.vy = 0;
        st.onGround = true;
      }
    }

    st.o.rotation.y = st.yaw;

    // ===== Anti-fly epilogue =====
    // (1) Streak decay: if the frame came and went without a single rise
    // we slowly whittle down the streak so a single step-up burst doesn't
    // permanently trip the wire later.
    if (st._gg) {
      const gg = st._gg;
      if (!gg.sawRiseThisFrame && gg.riseStreak > 0) gg.riseStreak--;

      // (2) COORDINATE HARD LIMIT — the last line of defense.
      // If the hero's feet are HOVERING well above the natural Island
      // terrain for long enough, regardless of the onGround flag, they
      // have flown off via raycast glitch.  (We used to gate on onGround
      // here too — but the gravity clamp path sets onGround=false exactly
      // when rising too fast, so the gate would never trip during a
      // glitch.)  Real jumps reach ~1.2 m so the 6 m / 2.9 s bar is safe.
      const now2 = Date.now ? Date.now() : 0;
      if (now2 > 0) {
        const s = Island.sample(st.o.position.x, st.o.position.z);
        const hover = st.o.position.y - s.y;
        const SUSPICIOUS = 6.0;
        const SUSTAIN_MS = 2850;
        if (hover >= SUSPICIOUS) {
          if (gg.floatSince === 0) gg.floatSince = now2;
          else if (now2 - gg.floatSince >= SUSTAIN_MS) {
            // Snap back to terrain and force island mode for a long ban so
            // the glitch mesh / probe configuration stops being consulted.
            st.o.position.y = s.y;
            st.vy = 0;
            st.onGround = true;
            gg.badUntil = now2 + 2800;
            gg.riseStreak = 0;
            gg.floatSince = 0;
          }
        } else {
          gg.floatSince = 0;
        }
      }
    }

    // ---- on-screen anti-fly HUD update (press V) ----
    if (st._dbg && st._dbg.show && st._dbg.el) {
      const now3 = Date.now ? Date.now() : 0;
      const s = Island.sample(st.o.position.x, st.o.position.z);
      const gg = st._gg;
      const inTrip = (now3 > 0 && now3 < gg.badUntil) ? 'YES ' + Math.ceil((gg.badUntil - now3)/100)/10 + 's' : '—';
      const floatFor = gg.floatSince > 0 ? (now3 > 0 ? ((now3 - gg.floatSince)/1000).toFixed(2)+'s' : '…') : '—';
      const isoY = s.y.toFixed(3);
      const py = st.o.position.y.toFixed(3);
      const hv = (st.o.position.y - s.y).toFixed(2) + 'm';
      const status = (
        '⟦ 调试面板 V 键关闭 ⟧\n' +
        '脚Y         : ' + py + '\n' +
        '地形Island.Y: ' + isoY + '\n' +
        '离地 hover  : ' + hv + ' (≥6m/2.9s硬兜底)\n' +
        'rise streak : ' + gg.riseStreak + ' / 6 trip\n' +
        'trip 倒计时 : ' + inTrip + '\n' +
        'hover 计时  : ' + floatFor + '\n' +
        'onGround    : ' + (st.onGround ? 'YES' : 'no') + '\n' +
        'vy          : ' + st.vy.toFixed(2)
      );
      if (st._dbg.lastSampled !== status) {
        st._dbg.el.textContent = status;
        st._dbg.lastSampled = status;
      }
    }
  }

  /**
   * Circle-vs-OBB collision against the building footprints the layout
   * engine recorded in TOWN.Colliders. Pushes the player out of every
   * solid box it overlaps, with a couple of passes so wall corners
   * resolve cleanly. Produces a sliding response (tangential motion is
   * kept) because the player is only displaced along the contact normal.
   */
  function resolveCollisions(st) {
    const cols = TOWN.Colliders;
    if (!cols || !cols.length) return;
    const R = st.radius;
    let ox = st.o.position.x, oz = st.o.position.z;

    for (let pass = 0; pass < 3; pass++) {
      let hit = false;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const dx = ox - c.x, dz = oz - c.z;
        const reach = R + c.r;                 // broadphase via half-diagonal
        if (dx * dx + dz * dz > reach * reach) continue;

        const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
        // world offset -> local frame (inverse of three.js Y-rotation)
        let lx = cos * dx - sin * dz;
        let lz = sin * dx + cos * dz;
        const hw = c.w / 2, hd = c.d / 2;
        const cx = U.clamp(lx, -hw, hw);       // closest point on the box
        const cz = U.clamp(lz, -hd, hd);
        let nx = lx - cx, nz = lz - cz;
        let dist = Math.hypot(nx, nz);

        if (dist > R) continue;                 // clear this box

        if (dist > 1e-6) {
          // outside the surface but within the radius — push out
          nx /= dist; nz /= dist;
          lx = cx + nx * R;
          lz = cz + nz * R;
        } else {
          // centre inside the box — eject to the nearest edge
          const dL = lx + hw, dR2 = hw - lx, dN = lz + hd, dF = hd - lz;
          const m = Math.min(dL, dR2, dN, dF);
          if (m === dL) lx = -hw - R;
          else if (m === dR2) lx = hw + R;
          else if (m === dN) lz = -hd - R;
          else lz = hd + R;
        }
        // local -> world
        ox = c.x + (cos * lx + sin * lz);
        oz = c.z + (-sin * lx + cos * lz);
        hit = true;
      }
      if (!hit) break;
    }

    st.o.position.x = ox;
    st.o.position.z = oz;

    // ---- dynamic (circle-vs-circle) pushes against vehicles and NPCs. ----
    // Run AFTER the OBB pass since buildings take priority.  Important: the
    // player is the ONLY body we displace here.  Vehicles and NPCs are
    // advanced by their own dynamics and must NEVER be nudged from outside —
    // doing so was the #1 cause of "pedestrian stuck replaying idle / tram
    // frozen at intersection" deadlocks.
    const Dyn = TOWN.Dynamics;
    const VEH = (Dyn && Dyn._systems && Dyn._systems.VEH) || [];
    const WALK = (Dyn && Dyn._systems && Dyn._systems.WALK) || [];
    const pR = st.radius;
    let pushAny = false;

    // vehicles: envelope radius ~2.1 m (sedan/tram average). Player side
    // only, 0.9 stiff — cars are heavy, we bounce off WITHOUT moving them.
    const MAX_STEP = 0.22;  // cap push per-frame (metres) to avoid flying
    for (let i = 0; i < VEH.length; i++) {
      const parts = VEH[i].parts; if (!parts || !parts.length) continue;
      for (let k = 0; k < parts.length; k++) {
        const pt = parts[k]; if (pt.joint) continue;
        const pos = pt.o.position;
        const dx = ox - pos.x, dz = oz - pos.z;
        const carR = 2.1;
        const rSum = pR + carR;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rSum * rSum || d2 <= 1e-6) continue;
        const d = Math.sqrt(d2);
        let push = (rSum - d) * 0.9;
        if (push > MAX_STEP) push = MAX_STEP;
        ox += dx / d * push;
        oz += dz / d * push;
        pushAny = true;
      }
    }
    // walkers + chatters — light separation.  STILL only move the player:
    // NPCs follow their own route / anchor and can't be displaced by us.
    for (let i = 0; i < WALK.length; i++) {
      const pos = WALK[i].o.position;
      const dx = ox - pos.x, dz = oz - pos.z;
      const bodyR = WALK[i].chat ? 0.65 : 0.52;
      const rSum = pR + bodyR;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rSum * rSum || d2 <= 1e-6) continue;
      const d = Math.sqrt(d2);
      let push = (rSum - d) * 0.45;
      if (push > MAX_STEP) push = MAX_STEP;
      ox += dx / d * push;
      oz += dz / d * push;
      pushAny = true;
    }
    if (pushAny) {
      // Cap the absolute maximum we could have moved this tick to avoid
      // being catapulted out of a crowd.  Clamp to a sphere of radius
      // 1.8x total push around previous position.
      const pdx = ox - st.o.position.x;
      const pdz = oz - st.o.position.z;
      const pd = Math.hypot(pdx, pdz);
      const PDMAX = 0.30;
      if (pd > PDMAX) {
        const s = PDMAX / pd;
        ox = st.o.position.x + pdx * s;
        oz = st.o.position.z + pdz * s;
      }
    }

    st.o.position.x = ox;
    st.o.position.z = oz;
  }

  /** animate(st, dt, et) — swing arms/legs, handle attack + jump poses. */
  function animate(st, dt, et) {
    const L = st.limbs, torso = st.torso;

    // advance walk phase by speed (matches crowd stride scaling)
    const strideRate = 2.9 / Math.max(0.6, st.scale);
    const movingAmt = U.clamp(st.speed / st.walkSpeed, 0, 1.4);
    st.walkPhase += st.speed * 0.62 * dt * strideRate;

    const sw = U.clamp(movingAmt, 0, 1);
    const ph = st.walkPhase;

    const airborne = !st.onGround;

    if (st.attacking > 0) {
      st.attacking -= dt;
      // big right-arm swing: ease out over the window
      const k = st.attacking / 0.4; // 0..1 remaining
      L[3].rotation.x = -2.1 * k;        // armR forward chop
      L[3].rotation.z = 0.3 * k;
      L[2].rotation.x = 0.4 * k;        // armL back for balance
      torso.rotation.y = -0.35 * k;
      // legs brace
      L[0].rotation.x = 0.25 * k;
      L[1].rotation.x = -0.25 * k;
    } else if (airborne) {
      // tuck for jump: legs up, arms out
      const tuck = st.vy > 0 ? 0.6 : 0.35;
      L[0].rotation.x = -tuck;
      L[1].rotation.x = -tuck;
      L[2].rotation.x = -0.9;
      L[3].rotation.x = -0.9;
      torso.position.y = st.hip;
    } else {
      // walking / idle, same math as the crowd
      L[0].rotation.x = Math.sin(ph) * 0.52 * sw;
      L[1].rotation.x = -Math.sin(ph) * 0.52 * sw;
      L[2].rotation.x = -Math.sin(ph) * 0.40 * sw - 0.06;
      L[3].rotation.x = Math.sin(ph) * 0.40 * sw - 0.06;
      torso.position.y = st.hip + Math.abs(Math.sin(ph)) * 0.030 * sw;
      torso.rotation.y = Math.sin(et * 0.63) * (0.10 + 0.2 * (1 - sw));
      torso.rotation.z = Math.sin(ph) * 0.030 * sw;
    }

    // idle breathing when standing still
    if (sw < 0.02 && !airborne && st.attacking <= 0) {
      torso.position.y = st.hip + Math.sin(et * 1.8) * 0.012;
      L[2].rotation.x = -0.06 + Math.sin(et * 1.8) * 0.03;
      L[3].rotation.x = -0.06 - Math.sin(et * 1.8) * 0.03;
    }

    // keep the contact blob flat on the ground (it's a child, so just hide in air)
    if (st.shadowBlob) {
      st.shadowBlob.visible = st.onGround;
      const s = 0.7 + 0.4 * sw;
      st.shadowBlob.scale.set(s, s, s);
      st.shadowBlob.material.opacity = airborne ? 0.12 : 0.26;
    }
  }

  /**
   * triggerAttack(st) — start a swing if not already swinging.
   * Returns true if a swing started (so the shell can check NPC hits
   * at the midpoint of the animation).
   */
  Player.triggerAttack = function (st) {
    if (st.attacking > 0) return false;
    st.attacking = 0.4;
    st.attackHit = false;
    return true;
  };

  /** shouldHitNow(st) — true during the active part of the swing. */
  Player.shouldHitNow = function (st) {
    return st.attacking > 0 && st.attacking > 0.16 && !st.attackHit;
  };
  Player.markHit = function (st) { st.attackHit = true; };

  /** eyePos(st, out) — world position of the head/eyes, for camera target. */
  Player.eyePos = function (st, out) {
    out = out || new T.Vector3();
    out.set(st.o.position.x, st.o.position.y + st.height * 0.92, st.o.position.z);
    return out;
  };

  /** update(st, input, camera, dt, et) — one frame. Returns the yaw the body faced. */
  Player.update = function (st, input, camera, dt, et) {
    applyMove(st, input, camera, dt);
    animate(st, dt, et);
    return st.yaw;
  };

  /* ===========================================================
     TOWN.FollowCam — third-person camera trailing the player
     =========================================================== */
  const FollowCam = TOWN.FollowCam = function (camera, player) {
    this.camera = camera;
    this.player = player;
    // spherical offset relative to the player's eye
    this.yaw = player ? player.yaw : 0;     // view yaw (behind player)
    this.pitch = 0.62;                      // down from horizontal
    this.dist = 6.4;
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.targetDist = this.dist;
    // smoothing
    this.curYaw = this.yaw;
    this.curPitch = this.pitch;
    this.curDist = this.dist;
    this.height = 1.55;                     // look target height above feet
    this.enabled = true;
    this.viewYaw = this.curYaw;             // movement reads this (curYaw mirror)
  };

  /**
   * The camera FOLLOWS THE PLAYER'S POSITION but keeps a fixed yaw —
   * it only re-orients when the user drags the screen (rotateBy).
   * This is deliberate: a fixed view yaw means "left" on the stick is
   * always world-left-of-camera, so movement stays predictable. An
   * auto-trailing camera would spin as you steer and make the controls
   * feel uncontrollable.
   */
  FollowCam.prototype.update = function (dt) {
    const st = this.player;
    if (!st) return;

    // smooth current toward target (target only moves on user drag)
    this.curYaw += U.angleDelta(this.curYaw, this.targetYaw) * Math.min(1, dt * 9);
    this.curPitch = U.damp(this.curPitch, this.targetPitch, 9, dt);
    this.curDist = U.damp(this.curDist, this.targetDist, 8, dt);

    // target point: player position + height
    _look.set(st.o.position.x, st.o.position.y + this.height, st.o.position.z);

    const cp = Math.cos(this.curPitch), sp = Math.sin(this.curPitch);
    _camPos.set(
      _look.x + Math.sin(this.curYaw) * this.curDist * cp,
      _look.y + this.curDist * sp,
      _look.z + Math.cos(this.curYaw) * this.curDist * cp
    );

    // don't dip the camera under the terrain
    const groundY = Island.heightAt(_camPos.x, _camPos.z) + 0.6;
    if (_camPos.y < groundY) _camPos.y = groundY;

    this.camera.position.lerp(_camPos, Math.min(1, dt * 12));
    this.camera.lookAt(_look);

    // expose the view yaw for movement (the direction the camera looks)
    this.viewYaw = this.curYaw;
  };

  /** rotateBy(dyaw, dpitch) — user drag input. */
  FollowCam.prototype.rotateBy = function (dyaw, dpitch) {
    this.targetYaw += dyaw;
    this.targetPitch = U.clamp(this.targetPitch + dpitch, 0.12, 1.32);
  };
  /** zoomBy(k) — pinch / wheel, k = ratio (e.g. 0.9 to zoom in). */
  FollowCam.prototype.zoomBy = function (k) {
    this.targetDist = U.clamp(this.targetDist * k, 3.2, 14);
  };
  /** snapBehind(st) — instantly snap behind the player (used on enter). */
  FollowCam.prototype.snap = function () {
    const st = this.player;
    this.targetYaw = this.curYaw = st.moveYaw + PI;
    this.curPitch = this.targetPitch;
    this.curDist = this.targetDist;
    this.viewYaw = this.curYaw;
    // also place the camera instantly so there's no fly-in lerp during
    // which the view direction would sweep and mismatch the controls
    _look.set(st.o.position.x, st.o.position.y + this.height, st.o.position.z);
    const cp = Math.cos(this.curPitch), sp = Math.sin(this.curPitch);
    this.camera.position.set(
      _look.x + Math.sin(this.curYaw) * this.curDist * cp,
      _look.y + this.curDist * sp,
      _look.z + Math.cos(this.curYaw) * this.curDist * cp
    );
    this.camera.lookAt(_look);
  };

  console.log('[TOWN] player + follow-cam ready');
})(window);
