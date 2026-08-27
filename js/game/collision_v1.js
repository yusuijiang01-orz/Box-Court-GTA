/* =============================================================
   js/game/collision_v1.js — GTA Collision v1

   Dedicated gameplay collision / walkable-proxy layer.

   Goals:
   - never raycast the full rendered scene for player grounding;
   - keep building solids separate from decorative placement footprints;
   - publish cheap WALKABLE proxies for roads, ramps, bridges and piers;
   - keep analytic Island.sample() as the WATER / natural-terrain authority;
   - preserve the existing Player controller by temporarily supplying a
     collision-aware Island.sample() only while Player.update() is running.

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
    BRIDGE: 'BRIDGE',
    PIER: 'PIER',
    RAMP: 'RAMP',
    WATER: 'WATER',
    TERRAIN: 'TERRAIN',
  });

  const C = TOWN.CollisionV1 = {
    version: '1.0.0',
    TYPES: TYPES,
    initialized: false,
    solids: [],
    walkables: [],
    stats: {},
  };

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
    const pad = Math.max(0.35, halfW);
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

  const BUILDING_NAMES = new Set([
    'frontage',
    'townHall', 'church', 'station', 'market', 'warehouse', 'lighthouse',
    'watermill', 'windmill', 'millerHouse', 'observatory',
    'rowTerrace', 'apartment', 'hotel', 'villa', 'cafe', 'townhouse',
    'cottage', 'tower_house', 'greenhouse', 'boathouse', 'shed'
  ]);

  function buildSolidProxies() {
    const legacy = Array.isArray(TOWN.Colliders) ? TOWN.Colliders : [];
    const out = [];
    for (let i = 0; i < legacy.length; i++) {
      const c = legacy[i];
      if (!c || !BUILDING_NAMES.has(c.name)) continue;

      // Legacy footprints are placement envelopes. Trim them slightly so the
      // player capsule collides with the visible mass rather than the layout's
      // construction clearance.
      const w = Math.max(0.6, c.w - 0.24);
      const d = Math.max(0.6, c.d - 0.24);
      out.push({
        x: c.x, z: c.z, w: w, d: d, rot: c.rot || 0,
        r: Math.hypot(w, d) * 0.5,
        name: c.name,
        type: TYPES.SOLID,
        source: 'layout-footprint',
      });
    }
    C.solids = out;
    TOWN.Colliders = out;
  }

  function buildRoadWalkables() {
    const corridors = Roads.corridors || [];
    for (let ci = 0; ci < corridors.length; ci++) {
      const c = corridors[ci];
      if (!c || !c.pts || c.pts.length < 2) continue;
      const halfW = Math.max(0.9, c.roadHalf || ((c.halfW || 2.2) - 0.35));
      const isRamp = String(c.name || '').indexOf('ramp_') === 0;
      for (let i = 0; i < c.pts.length - 1; i++) {
        const a = c.pts[i], b = c.pts[i + 1];
        const mx = (a[0] + b[0]) * 0.5, mz = (a[2] + b[2]) * 0.5;
        const natural = originalIslandSample(mx, mz);
        const kind = isRamp ? TYPES.RAMP : (!natural.land ? TYPES.BRIDGE : TYPES.ROAD);
        const priority = kind === TYPES.BRIDGE ? 26 : (kind === TYPES.RAMP ? 22 : 16);
        addSegment(a, b, halfW, kind, c.name || 'road', priority);
      }
    }

    if (Roads.PLAZA) {
      const p = Roads.PLAZA;
      const py = isFinite(Roads.plazaY) ? Roads.plazaY : originalIslandSample(p.x, p.z).y;
      addBox(p.x, p.z, py, p.w, p.d, p.rot || 0, TYPES.ROAD, 'plaza', 24);
    }
  }

  function buildBridgeWalkables() {
    // Harbour trestle: visual deck is a smooth hump, so model it directly
    // instead of using the flatter quay-road centreline beneath it.
    addBox(19.7, 37.7, 3.57, 24.5, 6.4, -0.045, TYPES.BRIDGE,
      'harbour-trestle', 40, function (lx) {
        let t = (lx + 24.5 * 0.5) / 24.5;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        return 3.57 + Math.sin(t * Math.PI) * 1.05;
      });

    const archDefs = [
      { x: -28.0, z: 6.5, span: 6.4, width: 7.4, rot: 0.9, lift: 0.28, name: 'main-arch' },
      { x: -24.2, z: 10.6, span: 5.6, width: 6.4, rot: 0.35, lift: 0.26, name: 'lane-arch' },
      { x: -30.5, z: -3.0, span: 4.6, width: 3.0, rot: 0.55, lift: 0.50, name: 'terrace-footbridge' },
    ];
    for (let i = 0; i < archDefs.length; i++) {
      const b = archDefs[i];
      const y = originalIslandSample(b.x, b.z).y + b.lift;
      addBox(b.x, b.z, y, b.span, b.width, b.rot, TYPES.BRIDGE, b.name, 36);
    }
  }

  function buildPierWalkables() {
    // Dimensions/rotations mirror Roads.build()'s four fixed pier placements.
    // The position Y is published through Roads.piers; +0.08 is plank top.
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
        TYPES.PIER, defs[i].name, 44);
    }
  }

  C.sample = function (x, z) {
    const natural = originalIslandSample(x, z);
    const hit = bestWalkable(x, z);
    if (!hit) {
      if (!natural.land) natural.collisionType = TYPES.WATER;
      else natural.collisionType = TYPES.TERRAIN;
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
    return { type: s.land ? TYPES.TERRAIN : TYPES.WATER, name: s.land ? 'island' : 'water', y: s.y };
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

    // Permanently disable the old scene-mesh grounding path. Setting both
    // caches before spawn also prevents shell.js from traversing the full scene
    // to build the expensive list in the first place.
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
    C.stats = {
      solids: C.solids.length,
      walkables: C.walkables.length,
      gridCells: walkGrid.size,
      byType: counts,
    };

    console.log('[TOWN] GTA Collision v1 ready:', C.stats);
    return C;
  };

  // Player integration. Only the player controller sees collision-aware
  // Island.sample(); the world generator/render systems keep the original
  // analytic terrain function.
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

  // Initialize after Layout/Roads have finished building, but before the shell
  // can spawn the player. missions.js already wraps Game.init; this outer wrap
  // keeps that behavior intact and then corrects marker Y onto proxy surfaces.
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
