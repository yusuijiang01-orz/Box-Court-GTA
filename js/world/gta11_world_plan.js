/* =============================================================
   js/world/gta11_world_plan.js — GTA-11B regional road planning

   Goals:
   - protect a wider, region-specific road safety envelope while Layout builds;
   - thin the ambient traffic population for the miniature road network;
   - prune decorative props that still intrude into driveable corridors;
   - keep real rendered road widths / minimap / CollisionV1 geometry unchanged.

   Loaded after layout.js but before app.js / Layout.build().
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Layout || !TOWN.Roads || !TOWN.Geo) return;

  const Layout = TOWN.Layout;
  const Roads = TOWN.Roads;
  const Geo = TOWN.Geo;
  if (Layout.__gta11RoadPlanWrapped) return;

  const Plan = TOWN.GTA11WorldPlan = {
    version: 'GTA-11B.1',
    widened: 0,
    pruned: 0,
    prunedColliders: 0,
    compactedFactories: [],
    trafficCaps: { town: 5, quay: 3, fair: 2, terrace: 2 },
  };

  const EXTRA = Object.freeze({
    mainSt: 1.30,
    midSt: 1.25,
    crossW: 1.15,
    crossB: 1.15,
    quayRing: 2.35,
    fairSt: 1.75,
    terraceSt: 1.30,
    knollTrack: 0.90,
    beachTrack: 0.80,
    ramp_toQuay: 1.55,
    ramp_toFair: 1.45,
    ramp_toTerrace: 1.40,
  });

  const PRUNE_KINDS = new Set([
    'crate', 'crateStack', 'barrel', 'sackPile', 'fishCrate', 'lobsterTrap',
    'fishingNet', 'anchorProp', 'buoy', 'rowboatProp', 'capstan',
    'marketStall', 'stall', 'kiosk', 'parasol', 'chairSet', 'cafeTerrace',
    'trashBin', 'noticeBoard', 'postbox', 'bollard', 'bicycle', 'bench',
    'streetTree', 'treeGuard', 'hedge', 'fence', 'potPlant', 'wheelbarrow',
    'haystack', 'birdhouse', 'beehive', 'waterTrough', 'phoneBooth', 'busStop',
    'well', 'sundial', 'milestone'
  ]);

  function extraFor(c) {
    if (!c) return 0;
    const name = String(c.name || '');
    if (Object.prototype.hasOwnProperty.call(EXTRA, name)) return EXTRA[name];
    if (name.indexOf('ramp_') === 0) return 1.15;
    return c.pts && c.pts.length > 1 ? 0.95 : 0;
  }

  function compactFactory(name, factor) {
    const Props = TOWN.Props;
    if (!Props || typeof Props[name] !== 'function') return;
    const original = Props[name];
    if (original.__gta11Compact) return;
    const wrapped = function () {
      const g = original.apply(Props, arguments);
      if (!g || !g.isObject3D) return g;
      g.scale.multiplyScalar(factor);
      const fp = g.userData && g.userData.footprint;
      if (fp) {
        if (Number.isFinite(fp.w)) fp.w *= factor;
        if (Number.isFinite(fp.d)) fp.d *= factor;
      }
      if (g.userData && Number.isFinite(g.userData.height)) g.userData.height *= factor;
      return g;
    };
    wrapped.__gta11Compact = true;
    wrapped.__gta11Original = original;
    Props[name] = wrapped;
    Plan.compactedFactories.push(name);
  }

  compactFactory('crateStack', 0.82);
  compactFactory('sackPile', 0.84);
  compactFactory('fishCrate', 0.86);
  compactFactory('lobsterTrap', 0.84);
  compactFactory('fishingNet', 0.82);
  compactFactory('rowboatProp', 0.74);
  compactFactory('cafeTerrace', 0.76);
  compactFactory('marketStall', 0.86);
  compactFactory('kiosk', 0.86);

  function installTrafficCaps() {
    const Dyn = TOWN.Dynamics;
    if (!Dyn || typeof Dyn.traffic !== 'function' || Dyn.traffic.__gta11bCapped) return;
    const base = Dyn.traffic;
    const wrapped = function (opts) {
      opts = opts || {};
      const o = Object.assign({}, opts);
      const R = Roads.routes || {};
      if (o.points === R.townLoop) o.count = Math.min(Number(o.count) || 0, Plan.trafficCaps.town);
      else if (o.points === R.quayLoop) o.count = Math.min(Number(o.count) || 0, Plan.trafficCaps.quay);
      else if (o.points === R.fairLoop) o.count = Math.min(Number(o.count) || 0, Plan.trafficCaps.fair);
      else if (o.points === R.terraceLoop) o.count = Math.min(Number(o.count) || 0, Plan.trafficCaps.terrace);
      return base.call(Dyn, o);
    };
    wrapped.__gta11bCapped = true;
    wrapped.__gta11Original = base;
    Dyn.traffic = wrapped;
  }
  installTrafficCaps();

  function pointSegDist(x, z, a, b) {
    const ax = a[0], az = a[2], bx = b[0], bz = b[2];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-8 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = ax + dx * t, pz = az + dz * t;
    return Math.hypot(x - px, z - pz);
  }

  function corridorDistance(x, z, c) {
    if (!c || !c.pts || c.pts.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < c.pts.length - 1; i++) {
      const d = pointSegDist(x, z, c.pts[i], c.pts[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  function kindOf(o) {
    return String((o && o.userData && o.userData.kind) || (o && o.name) || '');
  }

  function isPrunableName(name) {
    if (PRUNE_KINDS.has(name)) return true;
    return /crate|barrel|sack|trap|net|stall|kiosk|chair|bench|hedge|fence|treeGuard|streetTree|bicycle|bollard|notice|trash|postbox|wheelbarrow|haystack|beehive|birdhouse|phoneBooth|busStop/.test(name);
  }

  function intrudesRoad(x, z, radius) {
    const cs = Roads.corridors || [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!c || !c.pts || c.pts.length < 2) continue;
      const name = String(c.name || '');
      if (!Object.prototype.hasOwnProperty.call(EXTRA, name) && name.indexOf('ramp_') !== 0) continue;
      const roadBand = Math.max(1.4, (Number(c.roadHalf) || Number(c.halfW) || 2.4) - 0.70);
      const safe = roadBand + Math.min(0.95, Math.max(0.18, radius * 0.42));
      if (corridorDistance(x, z, c) < safe) return true;
    }
    return false;
  }

  function pruneRoadIntrusions() {
    const root = Layout.root;
    if (!root) return;
    const remove = [];
    const wp = new global.THREE.Vector3();

    root.updateMatrixWorld(true);
    root.traverse(function (o) {
      if (!o || o === root || !o.parent || !o.userData) return;
      const name = kindOf(o);
      if (!isPrunableName(name)) return;
      if (o.isMesh || o.isLine || o.isPoints) return;
      const fp = o.userData.footprint;
      let radius = 0.65;
      if (fp) radius = Math.max(0.35, Math.max(Number(fp.w) || 0, Number(fp.d) || 0) * 0.5);
      o.getWorldPosition(wp);
      if (intrudesRoad(wp.x, wp.z, radius)) remove.push(o);
    });

    for (let i = 0; i < remove.length; i++) {
      const o = remove[i];
      if (o.parent) o.parent.remove(o);
    }
    Plan.pruned = remove.length;

    const cols = Array.isArray(TOWN.Colliders) ? TOWN.Colliders : [];
    const kept = [];
    let removedCols = 0;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const name = String(c && c.name || '');
      const r = c ? Math.max(0.35, Math.max(Number(c.w) || 0, Number(c.d) || 0) * 0.5) : 0;
      if (c && isPrunableName(name) && intrudesRoad(c.x, c.z, r)) { removedCols++; continue; }
      kept.push(c);
    }
    if (removedCols) TOWN.Colliders = kept;
    Layout.colliders = TOWN.Colliders;
    Plan.prunedColliders = removedCols;
  }

  const baseBuild = Layout.build;
  Layout.build = function (scene, opts) {
    opts = opts || {};
    const corridors = Roads.corridors || [];
    const saved = [];
    Plan.widened = 0;
    Plan.pruned = 0;
    Plan.prunedColliders = 0;

    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      if (!c || !(c.halfW > 0) || !c.pts || c.pts.length < 2) continue;
      const extra = extraFor(c);
      if (!(extra > 0)) continue;
      saved.push({ c: c, halfW: c.halfW });
      c.halfW += extra;
      Plan.widened++;
    }

    const wantsMerge = opts.merge !== false;
    const buildOpts = Object.assign({}, opts, { merge: false });
    let result;
    try {
      result = baseBuild.call(Layout, scene, buildOpts);
      pruneRoadIntrusions();
      if (wantsMerge && Layout.root) {
        const t0 = performance.now();
        Geo.mergeStatic(Layout.root);
        Layout.mergeMs = performance.now() - t0;
      }
      return result;
    } finally {
      for (let i = 0; i < saved.length; i++) saved[i].c.halfW = saved[i].halfW;
    }
  };

  Layout.__gta11RoadPlanWrapped = true;
  console.log('[GTA-11B] regional road plan ready');
})(window);
