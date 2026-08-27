/* =============================================================
   js/world/gta11_world_plan.js — GTA-11 road-clear world planning patch

   Loaded after layout.js but before app.js / Layout.build().
   It temporarily widens layout-only road safety corridors while the town is
   being placed, then restores the real rendered road widths afterwards.
   This keeps gameplay streets clear without changing road meshes, minimap,
   collision walkables or traffic routes.
   ============================================================= */
(function (global) {
  'use strict';

  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Layout || !TOWN.Roads) return;

  const Layout = TOWN.Layout;
  const Roads = TOWN.Roads;
  if (Layout.__gta11RoadPlanWrapped) return;

  const Plan = TOWN.GTA11WorldPlan = {
    version: 'GTA-11.1',
    widened: 0,
    compactedFactories: [],
  };

  const EXTRA = Object.freeze({
    mainSt: 1.15,
    midSt: 1.10,
    crossW: 1.00,
    crossB: 1.00,
    quayRing: 1.30,
    fairSt: 1.15,
    terraceSt: 1.05,
    knollTrack: 0.75,
    beachTrack: 0.70,
    ramp_toQuay: 1.20,
    ramp_toFair: 1.15,
    ramp_toTerrace: 1.15,
  });

  function extraFor(c) {
    if (!c) return 0;
    const name = String(c.name || '');
    if (Object.prototype.hasOwnProperty.call(EXTRA, name)) return EXTRA[name];
    if (name.indexOf('ramp_') === 0) return 1.0;
    return c.pts && c.pts.length > 1 ? 0.85 : 0;
  }

  // A few decorative groups are physically larger than the generic placement
  // footprint used by the old harbour/fairground loops. Make those groups a
  // little more compact so neighbouring props stop visually interpenetrating.
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

  compactFactory('crateStack', 0.86);
  compactFactory('sackPile', 0.86);
  compactFactory('fishCrate', 0.90);
  compactFactory('lobsterTrap', 0.88);
  compactFactory('fishingNet', 0.86);
  compactFactory('rowboatProp', 0.78);
  compactFactory('cafeTerrace', 0.82);
  compactFactory('marketStall', 0.92);
  compactFactory('kiosk', 0.92);

  const baseBuild = Layout.build;
  Layout.build = function (scene, opts) {
    const corridors = Roads.corridors || [];
    const saved = [];
    Plan.widened = 0;

    // Layout.build internally builds its road OBB reservation from halfW and
    // also places street trees/furniture from halfW. Widening it only during
    // placement therefore clears both procedural props and the explicit
    // harbour/fairground clutter loops. roadHalf is deliberately untouched so
    // existing building frontages retain their intended architectural line.
    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      if (!c || !(c.halfW > 0) || !c.pts || c.pts.length < 2) continue;
      const extra = extraFor(c);
      if (!(extra > 0)) continue;
      saved.push({ c: c, halfW: c.halfW });
      c.halfW += extra;
      Plan.widened++;
    }

    try {
      return baseBuild.call(Layout, scene, opts);
    } finally {
      // CollisionV1/minimap/gameplay must see the real road width, not the
      // temporary placement safety envelope.
      for (let i = 0; i < saved.length; i++) saved[i].c.halfW = saved[i].halfW;
    }
  };

  Layout.__gta11RoadPlanWrapped = true;
  console.log('[GTA-11] road-clear world plan ready');
})(window);
