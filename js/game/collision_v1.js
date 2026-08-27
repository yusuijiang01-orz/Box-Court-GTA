/* =============================================================
   js/game/collision_v1.js — GTA Collision v1.1

   Dedicated gameplay collision / walkable-proxy layer.

   v1.1 goals:
   - keep full-scene Mesh raycasts permanently disabled;
   - align gameplay ground height with the VISIBLE road / pavement / plaza /
     bridge / pier surfaces so the hero does not sink into raised geometry;
   - turn legacy placement footprints into EXPLICIT, profiled SOLID proxies
     instead of treating every large placement reservation as a wall;
   - add structural rail / fountain proxies that the old layout footprint list
     never described;
   - keep Island.sample() as natural-terrain + water authority.

   No vehicle physics, combat or NPC pathfinding lives here.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Player || !TOWN.Island) return;

  const Player = TOWN.Player;
  const Island = TOWN.Island;
  const Roads = TOWN.Roads || {};
  const originalIslandSample = Island.sample;

  const TYPES = Object.freeze({
    SOLID: 'SOLID',
    ROAD: 'ROAD',
    PAVEMENT: 'PAVEMENT',
    BRIDGE: 'BRIDGE',
    PIER: 'PIER',
    RAMP: 'RAMP',
    WATER: 'WATER',
    TERRAIN: 'TERRAIN',
  });

  const C = TOWN.CollisionV1 = {
    version: '1.1.0',
    TYPES: TYPES,
    initialized: false,
    solids: [],
    walkables: [],
    stats: {},
  };

  /* -----------------------------------------------------------
     WALKABLE spatial grid
     ----------------------------------------------------------- */
  const CELL = 8.0;
  const walkGrid = new Map();

  function key(ix, iz) { return ix + ',' + iz; }
  function cellX(x) { return Math.floor(x / CELL); }
  function cellZ(z) { return Math.floor(z / CELL); }

  function addToGrid(proxy) {
    C.walkables.push(proxy);
    const minX = cellX(proxy.minX), maxX = cellX(proxy.maxX);
    const minZ = cellZ(proxy.minZ), maxZ = cellZ(proxy.maxZ);
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const k = key(ix, iz);
        let bucket = walkGrid.get(k);
        if (!bucket) { bucket = []; walkGrid.set(k, bucket); }
        bucket.push(proxy);
      }
    }
  }

  function addSegment(a, b, halfW, kind, name, priority) {
    if (!a || !b) return;
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return;
    const pad = Math.max(0.20, halfW);
    addToGrid({
      shape: 'segment', kind: kind, name: name, priority: priority || 10,
      ax: ax, ay: ay, az: az, bx: bx, by: by, bz: bz,
      dx: dx, dz: dz, len2: len2, halfW: pad,
      minX: Math.min(ax, bx) - pad, maxX: Math.max(ax, bx) + pad,
      minZ: Math.min(az, bz) - pad, maxZ: Math.max(az, bz) + pad,
    });
  }

  function addBox(x, z, y, w, d, rot, kind, name, priority, heightFn) {
    const rr = Math.hypot(w, d) * 0.5;
    addToGrid({
      shape: 'box', kind: kind, name: name, priority: priority || 20,
      x: x, z: z, y: y, w: w, d: d, rot: rot || 0,
      cos: Math.cos(rot || 0), sin: Math.sin(rot || 0),
      heightFn: heightFn || null,
      minX: x - rr, maxX: x + rr, minZ: z - rr, maxZ: z + rr,
    });
  }

  function surfaceOn(proxy, x, z) {
    if (proxy.shape === 'segment') {
      const wx = x - proxy.ax, wz = z - proxy.az;
      let t = (wx * proxy.dx + wz * proxy.dz) / proxy.len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = proxy.ax + proxy.dx * t;
      const pz = proxy.az + proxy.dz * t;
      const ddx = x - px, ddz = z - pz;
      if (ddx * ddx + ddz * ddz > proxy.halfW * proxy.halfW) return null;
      return { y: proxy.ay + (proxy.by - proxy.ay) * t, proxy: proxy };
    }

    const dx = x - proxy.x, dz = z - proxy.z;
    const lx = proxy.cos * dx - proxy.sin * dz;
    const lz = proxy.sin * dx + proxy.cos * dz;
    if (Math.abs(lx) > proxy.w * 0.5 || Math.abs(lz) > proxy.d * 0.5) return null;
    const y = proxy.heightFn ? proxy.heightFn(lx, lz, proxy) : proxy.y;
    return { y: y, proxy: proxy };
  }

  function bestWalkable(x, z) {
    const bucket = walkGrid.get(key(cellX(x), cellZ(z)));
    if (!bucket || bucket.length === 0) return null;
    let best = null;
    for (let i = 0; i < bucket.length; i++) {
      const hit = surfaceOn(bucket[i], x, z);
      if (!hit) continue;
      if (!best || hit.proxy.priority > best.proxy.priority ||
          (hit.proxy.priority === best.proxy.priority && hit.y > best.y)) {
        best = hit;
      }
    }
    return best;
  }

  /* -----------------------------------------------------------
     GROUND SURFACE ALIGNMENT

     roads.js builds the road ribbon at gp.y (already terrain + 0.075), then
     raises pavement vertices another +0.14 / +0.15.  v1 used one wide proxy
     at road height, which made the hero visually sink into the pavement.
     These profiles mirror the procedural road specifications and split road
     and pavement into separate height bands.
     ----------------------------------------------------------- */
  const ROAD_PROFILES = Object.freeze({
    mainSt:          { w: 5.1, walk: 1.10 },
    midSt:           { w: 4.3, walk: 0.85 },
    crossW:          { w: 3.5, walk: 0.60 },
    crossB:          { w: 3.7, walk: 0.70 },
    quayRing:        { w: 4.8, walk: 1.00 },
    fairSt:          { w: 4.5, walk: 0.95 },
    terraceSt:       { w: 4.0, walk: 0.75 },
    knollTrack:      { w: 3.2, walk: 0.00 },
    beachTrack:      { w: 3.0, walk: 0.00 },
    ramp_toQuay:     { w: 4.8, walk: 0.95 },
    ramp_toFair:     { w: 4.5, walk: 0.85 },
    ramp_toTerrace:  { w: 4.6, walk: 0.95 },
  });

  function offsetPathPoint(pts, i, side, offset, yLift) {
    const n = pts.length;
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = -dz * side, nz = dx * side;
    return [p[0] + nx * offset, p[1] + yLift, p[2] + nz * offset];
  }

  function buildRoadWalkables() {
    const corridors = Roads.corridors || [];
    for (let ci = 0; ci < corridors.length; ci++) {
      const c = corridors[ci];
      if (!c || !c.pts || c.pts.length < 2) continue;

      const name = String(c.name || 'road');
      const prof = ROAD_PROFILES[name];
      // Fallback stays conservative for future roads not yet in the profile.
      const roadW = prof ? prof.w : Math.max(1.8, (c.roadHalf || 2.4) * 2 - 1.4);
      const walkW = prof ? prof.walk : 0;
      const roadHalf = roadW * 0.5 + 0.04;
      const isRamp = name.indexOf('ramp_') === 0;

      for (let i = 0; i < c.pts.length - 1; i++) {
        const a = c.pts[i], b = c.pts[i + 1];
        const mx = (a[0] + b[0]) * 0.5, mz = (a[2] + b[2]) * 0.5;
        const natural = originalIslandSample(mx, mz);
        const kind = isRamp ? TYPES.RAMP : (!natural.land ? TYPES.BRIDGE : TYPES.ROAD);
        const priority = kind === TYPES.BRIDGE ? 27 : (kind === TYPES.RAMP ? 24 : 18);
        addSegment(a, b, roadHalf, kind, name + ':road', priority);
      }

      // Sidewalk visual vertices sit about 14–15 cm above the road ribbon.
      if (walkW > 0.02) {
        const off = roadW * 0.5 + walkW * 0.5 - 0.025;
        const hw = walkW * 0.5 + 0.075; // small overlap hides curb seams
        for (const side of [-1, 1]) {
          const op = new Array(c.pts.length);
          for (let i = 0; i < c.pts.length; i++) {
            op[i] = offsetPathPoint(c.pts, i, side, off, 0.145);
          }
          for (let i = 0; i < op.length - 1; i++) {
            addSegment(op[i], op[i + 1], hw, TYPES.PAVEMENT,
              name + ':pavement:' + side, 31);
          }
        }
      }
    }

    // buildPlaza() puts the visible slab at terrain + 0.14; use that exact top.
    if (Roads.PLAZA) {
      const p = Roads.PLAZA;
      const py = originalIslandSample(p.x, p.z).y + 0.14;
      addBox(p.x, p.z, py, p.w, p.d, p.rot || 0, TYPES.PAVEMENT, 'plaza', 34);
    }
  }

  function buildBridgeWalkables() {
    // Harbour trestle planks: group Y is deck top; individual planks follow
    // sin(t*pi)*1.05 exactly, so this proxy matches the visible hump.
    addBox(19.7, 37.7, 3.57, 24.5, 6.4, -0.045, TYPES.BRIDGE,
      'harbour-trestle', 50, function (lx) {
        let t = (lx + 24.5 * 0.5) / 24.5;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        return 3.57 + Math.sin(t * Math.PI) * 1.05;
      });

    // archBridge() places its deck top exactly at group origin Y.
    const archDefs = [
      { x: -28.0, z: 6.5, span: 6.4, width: 7.4, rot: 0.9,  lift: 0.28, name: 'main-arch' },
      { x: -24.2, z: 10.6, span: 5.6, width: 6.4, rot: 0.35, lift: 0.26, name: 'lane-arch' },
      { x: -30.5, z: -3.0, span: 4.6, width: 3.0, rot: 0.55, lift: 0.50, name: 'terrace-footbridge' },
    ];
    for (let i = 0; i < archDefs.length; i++) {
      const b = archDefs[i];
      const y = originalIslandSample(b.x, b.z).y + b.lift;
      addBox(b.x, b.z, y, b.span, b.width, b.rot, TYPES.BRIDGE, b.name, 46);
    }
  }

  function buildPierWalkables() {
    // pier() planks are centred at local y=0 with height .16 => top = +.08.
    const defs = [
      { w: 3.4, d: 12.0, rot: Math.PI / 2 + 0.05, name: 'harbour-pier-west' },
      { w: 3.0, d: 9.0,  rot: 0.03,                 name: 'harbour-pier-mid' },
      { w: 2.8, d: 10.0, rot: Math.PI / 2 - 0.06, name: 'harbour-pier-east' },
      { w: 2.4, d: 8.0,  rot: Math.PI / 2,        name: 'cove-jetty' },
    ];
    const piers = Roads.piers || [];
    for (let i = 0; i < defs.length && i < piers.length; i++) {
      const p = piers[i];
      if (!p) continue;
      addBox(p[0], p[2], p[1] + 0.08, defs[i].w, defs[i].d, defs[i].rot,
        TYPES.PIER, defs[i].name, 54);
    }
  }

  /* -----------------------------------------------------------
     SOLID ASSET PROFILES

     TOWN.Colliders is a legacy placement-footprint list.  v1 whitelisted only
     buildings, so many fixed structures could be walked through.  v1.1 keeps
     the list as source data but assigns a physical profile per asset class.
     This is intentionally conservative: no generic "large object = wall" rule.
     ----------------------------------------------------------- */
  const BUILDING_NAMES = new Set([
    'frontage',
    'townHall', 'church', 'station', 'library', 'market', 'warehouse',
    'lighthouse', 'watermill', 'windmill', 'millerHouse', 'observatory',
    'rowTerrace', 'apartment', 'hotel', 'villa', 'cafe', 'townhouse',
    'cottage', 'tower_house', 'greenhouse', 'boathouse', 'shed'
  ]);

  const NON_SOLID_NAMES = new Set([
    'plaza', 'probe', 'claim', 'field', 'vegPatch', 'flowerPatch',
    'washingLine', 'lanternString', 'bunting', 'beachGrass', 'cliffRocks',
    'rockCluster', 'rock', 'parasol', 'chairSet'
  ]);

  function solid(x, z, w, d, rot, name, source) {
    w = Math.max(0.20, w); d = Math.max(0.20, d);
    return {
      x: x, z: z, w: w, d: d, rot: rot || 0,
      r: Math.hypot(w, d) * 0.5,
      name: name || 'solid', type: TYPES.SOLID, source: source || 'profile',
    };
  }

  // local (+X,+Z) offset -> world, using the same Y-rotation convention as
  // Player.resolveCollisions().
  function solidLocal(out, c, lx, lz, w, d, name, source) {
    const rot = c.rot || 0;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const x = c.x + cs * lx + sn * lz;
    const z = c.z - sn * lx + cs * lz;
    out.push(solid(x, z, w, d, rot, name, source));
  }

  function addLegacyProfile(out, c) {
    if (!c || NON_SOLID_NAMES.has(c.name)) return;
    const name = String(c.name || '');

    if (BUILDING_NAMES.has(name)) {
      // Building footprint includes eaves / trims. Pull the gameplay wall line
      // inward so collision is close to the visible primary mass.
      out.push(solid(c.x, c.z,
        Math.max(0.8, c.w * 0.91), Math.max(0.8, c.d * 0.91),
        c.rot || 0, name, 'building-tag'));
      return;
    }

    if (name === 'cityGate') {
      // Preserve the centre arch as a passage: two side masses, not one wall.
      const postW = Math.max(0.65, c.w * 0.27);
      const opening = Math.max(1.2, c.w * 0.40);
      const off = opening * 0.5 + postW * 0.5;
      solidLocal(out, c, -off, 0, postW, c.d * 0.88, 'cityGate:left', 'structure-tag');
      solidLocal(out, c,  off, 0, postW, c.d * 0.88, 'cityGate:right', 'structure-tag');
      return;
    }

    if (name === 'gazebo') {
      // Four posts keep the pavilion enterable instead of blocking its floor.
      const pw = Math.min(0.70, Math.max(0.42, Math.min(c.w, c.d) * 0.13));
      const ox = Math.max(0, c.w * 0.5 - pw * 0.8);
      const oz = Math.max(0, c.d * 0.5 - pw * 0.8);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        solidLocal(out, c, sx * ox, sz * oz, pw, pw, 'gazebo:post', 'structure-tag');
      }
      return;
    }

    if (name === 'fence' || name === 'hedge') {
      // Keep the long axis, clamp only the thickness.
      let w = c.w * 0.94, d = c.d * 0.94;
      if (w >= d) d = Math.min(d, name === 'fence' ? 0.55 : 0.80);
      else w = Math.min(w, name === 'fence' ? 0.55 : 0.80);
      out.push(solid(c.x, c.z, w, d, c.rot || 0, name, 'linear-tag'));
      return;
    }

    if (name === 'greatTree' || name === 'streetTree') {
      out.push(solid(c.x, c.z, 0.95, 0.95, c.rot || 0, name, 'trunk-tag'));
      return;
    }

    if (name === 'statue') {
      out.push(solid(c.x, c.z, Math.min(1.7, c.w), Math.min(1.7, c.d),
        c.rot || 0, name, 'monument-tag'));
      return;
    }

    if (name === 'crane' || name === 'harbourCrane') {
      out.push(solid(c.x, c.z, Math.min(1.7, c.w), Math.min(1.7, c.d),
        c.rot || 0, name, 'structure-tag'));
      return;
    }

    if (name === 'stall' || name === 'marketStall' || name === 'kiosk') {
      out.push(solid(c.x, c.z, c.w * 0.82, c.d * 0.82,
        c.rot || 0, name, 'stall-tag'));
      return;
    }

    if (name === 'carousel') {
      out.push(solid(c.x, c.z, c.w * 0.82, c.d * 0.82,
        c.rot || 0, name, 'ride-tag'));
      return;
    }

    if (name === 'swing' || name === 'playground') {
      out.push(solid(c.x, c.z, c.w * 0.60, c.d * 0.60,
        c.rot || 0, name, 'ride-tag'));
      return;
    }

    if (name === 'ferris') {
      // Approximate the support/base zone, not the full wheel envelope.
      out.push(solid(c.x, c.z, c.w * 0.38, c.d * 0.52,
        c.rot || 0, name, 'ride-tag'));
      return;
    }
  }

  function addKnownStructuralSolids(out) {
    // Fountain is not in Layout.taken[], so publish its basin explicitly.
    out.push(solid(15.0, -5.5, 3.65, 3.65, 0.03, 'fountain', 'known-structure'));

    // Bridge parapets / trestle rails. They are visually solid but were not
    // represented in the legacy placement-footprint collider list.
    const bridges = [
      { x: 19.7, z: 37.7, rot: -0.045, span: 24.5, width: 6.4, edge: 0.22, tag: 'trestle-rail' },
      { x: -28.0, z: 6.5, rot: 0.9, span: 6.4, width: 7.4, edge: 0.34, tag: 'main-arch-parapet' },
      { x: -24.2, z: 10.6, rot: 0.35, span: 5.6, width: 6.4, edge: 0.34, tag: 'lane-arch-parapet' },
      { x: -30.5, z: -3.0, rot: 0.55, span: 4.6, width: 3.0, edge: 0.34, tag: 'footbridge-parapet' },
    ];
    for (let i = 0; i < bridges.length; i++) {
      const b = bridges[i];
      const fake = { x: b.x, z: b.z, rot: b.rot };
      const off = b.width * 0.5 - b.edge * 0.5;
      solidLocal(out, fake, 0, -off, b.span + 0.25, b.edge, b.tag + ':L', 'bridge-rail');
      solidLocal(out, fake, 0,  off, b.span + 0.25, b.edge, b.tag + ':R', 'bridge-rail');
    }
  }

  function buildSolidProxies() {
    const legacy = Array.isArray(TOWN.Colliders) ? TOWN.Colliders : [];
    const out = [];
    for (let i = 0; i < legacy.length; i++) addLegacyProfile(out, legacy[i]);
    addKnownStructuralSolids(out);
    C.solids = out;
    TOWN.Colliders = out;
  }

  /* -----------------------------------------------------------
     Public sampling
     ----------------------------------------------------------- */
  C.sample = function (x, z) {
    const natural = originalIslandSample(x, z);
    const hit = bestWalkable(x, z);
    if (!hit) {
      natural.collisionType = natural.land ? TYPES.TERRAIN : TYPES.WATER;
      natural.collisionName = natural.land ? 'island' : 'water';
      return natural;
    }

    return {
      y: hit.y,
      land: true,
      tier: natural.tier,
      padW: natural.padW,
      coast: natural.coast,
      stream: natural.stream,
      collisionType: hit.proxy.kind,
      collisionName: hit.proxy.name,
    };
  };

  C.heightAt = function (x, z) { return C.sample(x, z).y; };
  C.surfaceAt = function (x, z) {
    const hit = bestWalkable(x, z);
    if (hit) return { type: hit.proxy.kind, name: hit.proxy.name, y: hit.y };
    const s = originalIslandSample(x, z);
    return { type: s.land ? TYPES.TERRAIN : TYPES.WATER,
      name: s.land ? 'island' : 'water', y: s.y };
  };

  function refreshMissionMarkers() {
    const M = TOWN.Missions;
    if (!M || !M.initialized) return;
    const markers = [M.startMarker, M.targetMarker];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (!m) continue;
      const s = C.sample(m.position.x, m.position.z);
      m.position.y = s.y + 0.03;
    }
  }

  C.init = function () {
    if (C.initialized) return C;
    C.initialized = true;

    // Never rebuild / consult the old full-scene walkable Mesh list.
    Player.groundMeshes = [];
    if (TOWN.Game) TOWN.Game.groundMeshes = [];

    buildSolidProxies();
    buildRoadWalkables();
    buildBridgeWalkables();
    buildPierWalkables();

    const counts = {};
    for (let i = 0; i < C.walkables.length; i++) {
      const k = C.walkables[i].kind;
      counts[k] = (counts[k] || 0) + 1;
    }
    const solidSources = {};
    for (let i = 0; i < C.solids.length; i++) {
      const k = C.solids[i].source || 'unknown';
      solidSources[k] = (solidSources[k] || 0) + 1;
    }
    C.stats = {
      version: C.version,
      solids: C.solids.length,
      walkables: C.walkables.length,
      gridCells: walkGrid.size,
      byType: counts,
      solidSources: solidSources,
    };

    console.log('[TOWN] GTA Collision v1.1 ready:', C.stats);
    return C;
  };

  // Only the player controller sees collision-aware Island.sample(). The world
  // generator and renderer continue to use the original analytic terrain.
  if (!Player.__collisionV1Wrapped) {
    const playerUpdate = Player.update;
    Player.update = function (st, input, camera, dt, et) {
      C.init();
      Player.groundMeshes = [];
      const savedSample = Island.sample;
      Island.sample = C.sample;
      try {
        return playerUpdate.call(Player, st, input, camera, dt, et);
      } finally {
        Island.sample = savedSample;
      }
    };
    Player.__collisionV1Wrapped = true;
  }

  // Initialize after Layout/Roads have built but before shell spawn logic. The
  // outer wrapper preserves the mission wrapper installed earlier in load order.
  if (TOWN.Game && !TOWN.Game.__collisionV1InitWrapped) {
    const gameInit = TOWN.Game.init;
    TOWN.Game.init = function () {
      C.init();
      const out = gameInit.apply(TOWN.Game, arguments);
      refreshMissionMarkers();
      return out;
    };
    TOWN.Game.__collisionV1InitWrapped = true;
  }
})(window);
