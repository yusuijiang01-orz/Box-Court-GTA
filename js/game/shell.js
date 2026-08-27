/* =============================================================
   js/game/shell.js — TOWN.Game

   The shell around the playable mode: a start screen, a settings
   page that owns the day/night clock, a mobile HUD (left joystick +
   right action buttons), an NPC dialogue box, and the state machine
   that stitches it to the existing diorama boot/render loop.

   Modes:  'start' → start screen over a slowly auto-rotating town
           'play'  → controllable character, follow-cam, HUD
           'diorama' → the original free-orbit viewer (with the panel)
   Settings can open as an overlay on top of any mode.
   ============================================================= */
(function (global) {
  'use strict';
  const T = global.THREE;
  const TOWN = global.TOWN;
  const U = TOWN.U;
  const Island = TOWN.Island;

  const me = {
    mode: 'start',
    settingsOpen: false,
    preMode: 'start',
    ready: false,
    player: null,
    cam: null,
    input: null,
    npcs: [],
    npcLines: [],
    bubbles: [],            // active speech bubbles [{el, npc, t}]
    bubbleLayer: null,
    tmp: new T.Vector3(),
    el: {},
  };
  TOWN.Game = me;

  /* ---- dialogue lines (warm, storybook, town-flavoured) ---- */
  const LINES = [
    '今天的海风很舒服，你说是不是？',
    '听说灯塔那边黄昏时能看到海豚。',
    '广场的面包店刚出炉，去晚可就没了。',
    '我每天都要去山顶的观景台坐一会儿。',
    '风车转得越快，明天的风就越大。',
    '别看码头现在安静，渔船回来时可热闹了。',
    '台地上的花园开满了花，去看看吧。',
    '夜里的灯火，像撒了一地的星星。',
    '我家的小猫又溜到游乐场去了。',
    '这台阶我爬了三十年，还是没爬腻。',
    '你闻到了吗？是桉树的味道。',
    '愿你的旅途一路顺风。',
    '正午的喷泉底下会有彩虹。',
    '我在等一个老朋友，他快来了。',
    '海港起雾时，整座镇子都安静下来。',
    '游乐场的旋转木马，转着转着人就长大了。',
    '桥那头的灯一到晚上就亮，真好看。',
    '你要是累了，就来这长椅坐坐。',
  ];
  const REACT = ['哎哟！', '别打我！', '干嘛啦！', '嘿！', '轻点呀！', '哎呀！'];

  /* ---- tiny DOM helper ---- */
  function el(tag, cls, html, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const $ = (s) => document.querySelector(s);

  /* ===========================================================
     NPC collection — gather every resident so dialogue + attack
     reactions can find the nearest one.
     =========================================================== */
  function collectNPCs() {
    const list = [];
    TOWN.Stage.scene.traverse((o) => {
      if (!o.userData) return;
      const k = o.userData.kind;
      if (k === 'pedestrian') list.push(o);
      else if (k === 'crowd' && o.userData.people) {
        o.userData.people.forEach((p) => { if (p) list.push(p); });
      }
    });
    // assign each a stable line + a name tag
    list.forEach((n, i) => {
      n.userData.npcId = i;
      n.userData.line = LINES[i % LINES.length];
      n.userData.name = '居民' + ((i % 12) + 1);
    });
    me.npcs = list;
    console.log('[TOWN] NPCs: ' + list.length);
    return list;
  }

  /** nearest NPC to the player within `range`, optionally within front cone. */
  function nearestNPC(range, cone) {
    if (!me.player) return null;
    const px = me.player.o.position.x, pz = me.player.o.position.z;
    let best = null, bd = range * range;
    const yaw = me.player.yaw;
    for (let i = 0; i < me.npcs.length; i++) {
      const n = me.npcs[i];
      const dx = n.position.x - px, dz = n.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > bd) continue;
      if (cone !== undefined) {
        // forward dir = (sin yaw, 0, cos yaw); dot must be > cos(cone)
        const dl = Math.sqrt(d2) || 1e-3;
        const dot = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / dl;
        if (dot < Math.cos(cone)) continue;
      }
      if (d2 < bd) { bd = d2; best = n; }
    }
    return best;
  }

  /* ===========================================================
     DOM construction
     =========================================================== */
  function buildDOM() {
    // ---- start screen ----
    const start = el('div', 'screen', `
      <div class="screen-card">
        <div class="screen-eyebrow">Diorama Town</div>
        <h1 class="screen-title">箱庭小镇</h1>
        <p class="screen-sub">海港 · 阶梯小镇 · 昼夜流转</p>
        <div class="screen-actions">
          <button class="btn primary" id="btn-start">开始游戏</button>
          <button class="btn" id="btn-start-settings">设置</button>
        </div>
        <div class="screen-hint">
          左摇杆移动 · 右侧按钮奔跑/跳跃/攻击/对话<br>
          拖动屏幕可转动视角 · 双指缩放
        </div>
      </div>`, { id: 'start-screen' });
    document.body.appendChild(start);
    me.el.start = start;

    // ---- settings ----
    const settings = el('div', 'screen settings hidden', `
      <div class="screen-card wide">
        <div class="screen-head">
          <h2>设置</h2>
          <button class="btn icon" id="set-close">×</button>
        </div>

        <section class="set-sec">
          <h3>时间</h3>
          <div id="set-timelabel" class="set-time">08:24　清晨</div>
          <input id="set-time" type="range" min="0" max="24" step="0.01" value="8.4">
          <div class="row wrap set-presets">
            <button data-hour="5.6">黎明</button>
            <button data-hour="8.5">清晨</button>
            <button data-hour="12.5">正午</button>
            <button data-hour="17.8">黄金</button>
            <button data-hour="18.9">日落</button>
            <button data-hour="20.4">暮色</button>
            <button data-hour="22.5">夜晚</button>
            <button data-hour="1.5">深夜</button>
          </div>
          <div class="row set-toggles">
            <button id="set-auto" class="wide">自动昼夜</button>
          </div>
          <label class="slab">流速 <span id="set-speedlabel">0.10×</span></label>
          <input id="set-speed" type="range" min="0.05" max="3" step="0.05" value="0.1">
        </section>

        <section class="set-sec">
          <h3>画面</h3>
          <div class="row wrap">
            <button data-quality="low">低</button>
            <button data-quality="mid">中</button>
            <button data-quality="high">高</button>
          </div>
          <div class="row wrap">
            <button id="set-dyn">动态元素</button>
            <button id="set-shadow">阴影</button>
            <button id="set-fog">雾气</button>
          </div>
        </section>

        <section class="set-sec">
          <h3>视角</h3>
          <div class="row">
            <button id="set-freeview" class="wide">自由观景</button>
          </div>
          <div class="row">
            <button id="set-shot" class="wide ghost">保存截图</button>
          </div>
        </section>

        <div class="screen-actions">
          <button class="btn primary" id="set-return">返回</button>
        </div>
      </div>`, { id: 'settings' });
    document.body.appendChild(settings);
    me.el.settings = settings;

    // ---- HUD ----
    const hud = el('div', 'hud hidden', '', { id: 'hud' });
    hud.innerHTML = `
      <div class="topbar">
        <div class="timechip" id="timechip">08:24 清晨</div>
        <button class="hud-btn" id="hud-orbit" title="全场预览">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3 V4"/><path d="M12 20 V21"/><path d="M3 12 H4"/><path d="M20 12 H21"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>
        </button>
        <button class="hud-btn gear" id="hud-gear" title="设置">⚙</button>
      </div>
      <div class="joy" id="joy">
        <div class="joy-base"></div>
        <div class="joy-knob" id="knob"></div>
      </div>
      <div class="actionpad">
        <button class="hud-btn act hold" data-name="run" title="奔跑"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="4.5" r="1.8"/><path d="M15 6.5 11 11 7 12"/><path d="M11 11 15 13 16 17"/><path d="M12.5 8.5 8.5 9.5"/><path d="M13.5 9 17.5 7"/></svg></button>
        <button class="hud-btn act" data-name="jump" title="跳跃"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18 V8"/><path d="M7.5 12.5 12 8 16.5 12.5"/><path d="M3.5 18.5 a8.5 8.5 0 0 1 17 0"/></svg></button>
        <button class="hud-btn act" data-name="attack" title="攻击"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg></button>
        <button class="hud-btn act primary" data-name="interact" title="对话/交互"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/><circle cx="8.5" cy="11" r="0.9" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r="0.9" fill="currentColor" stroke="none"/><circle cx="15.5" cy="11" r="0.9" fill="currentColor" stroke="none"/></svg></button>
      </div>`;
    document.body.appendChild(hud);
    me.el.hud = hud;

    // ---- dialogue box ----
    const dlg = el('div', 'dialogue hidden', `
      <div class="dlg-inner">
        <div class="dlg-name" id="dlg-name">居民</div>
        <div class="dlg-line" id="dlg-line"></div>
        <div class="dlg-hint">点击继续</div>
      </div>`, { id: 'dialogue' });
    document.body.appendChild(dlg);
    me.el.dialogue = dlg;

    // ---- bubble layer (for attack reactions / "tap to talk" prompts) ----
    const bl = el('div', 'bubble-layer', '', { id: 'bubble-layer' });
    document.body.appendChild(bl);
    me.bubbleLayer = bl;
  }

  /* ===========================================================
     Settings — owns the day/night clock + view toggles.
     =========================================================== */
  function timeLabel(h) {
    const hh = Math.floor(U.mod(h, 24));
    const mm = Math.floor((h - Math.floor(h)) * 60);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    let name = '深夜';
    if (h >= 4.6 && h < 6.4) name = '黎明';
    else if (h >= 6.4 && h < 10) name = '清晨';
    else if (h >= 10 && h < 14.5) name = '正午';
    else if (h >= 14.5 && h < 17) name = '午后';
    else if (h >= 17 && h < 18.7) name = '黄金时刻';
    else if (h >= 18.7 && h < 19.8) name = '日落';
    else if (h >= 19.8 && h < 21.5) name = '暮色';
    else if (h >= 21.5 || h < 4.6) name = '夜晚';
    return pad(hh) + ':' + pad(mm) + '　' + name;
  }
  // expose for app.js topbar sync
  me.timeLabel = timeLabel;

  function bindSettings() {
    const App = TOWN.App;
    const sl = $('#set-time'), lab = $('#set-timelabel');
    function syncTime() {
      if (sl && document.activeElement !== sl) sl.value = App.hours.toFixed(2);
      if (lab) lab.textContent = timeLabel(App.hours);
      const chip = $('#timechip');
      if (chip) chip.textContent = timeLabel(App.hours).replace('　', ' ');
    }
    me.syncTime = syncTime;

    if (sl) sl.addEventListener('input', () => {
      App.hours = parseFloat(sl.value); App.auto = false;
      $('#set-auto').classList.remove('on');
      TOWN.Sky.setHours(App.hours); syncTime();
    });
    document.querySelectorAll('#settings [data-hour]').forEach((b) => {
      b.addEventListener('click', () => {
        App.hours = parseFloat(b.dataset.hour); App.auto = false;
        $('#set-auto').classList.remove('on');
        TOWN.Sky.setHours(App.hours); syncTime();
      });
    });
    const auto = $('#set-auto');
    if (auto) {
      auto.classList.toggle('on', App.auto);
      auto.addEventListener('click', () => {
        App.auto = !App.auto; auto.classList.toggle('on', App.auto);
      });
    }
    const sp = $('#set-speed'), spl = $('#set-speedlabel');
    if (sp) sp.addEventListener('input', () => {
      App.speed = parseFloat(sp.value);
      if (spl) spl.textContent = App.speed.toFixed(2) + '×';
    });
    // reflect the current App.speed (default 0.1×) into the slider + label
    if (sp) sp.value = App.speed;
    if (spl) spl.textContent = App.speed.toFixed(2) + '×';

    // quality
    document.querySelectorAll('#settings [data-quality]').forEach((b) => {
      if (b.dataset.quality === App.quality) b.classList.add('on');
      b.addEventListener('click', () => {
        TOWN.App.applyQuality && TOWN.App.applyQuality(b.dataset.quality);
        document.querySelectorAll('#settings [data-quality]').forEach((o) => o.classList.remove('on'));
        b.classList.add('on');
      });
    });
    // toggles
    const tg = (id, get, set) => {
      const b = $(id); if (!b) return;
      b.classList.toggle('on', get());
      b.addEventListener('click', () => { set(!get()); b.classList.toggle('on', get()); });
    };
    tg('#set-dyn', () => App.dynamics, (v) => { App.dynamics = v; TOWN.Env.reduced = !v; });
    tg('#set-shadow', () => App.shadows, (v) => {
      App.shadows = v;
      TOWN.Stage.renderer.shadowMap.enabled = v && App.quality !== 'low';
      TOWN.Stage.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    });
    tg('#set-fog', () => App.fogOn, (v) => {
      App.fogOn = v;
      const sc = TOWN.Stage.scene;
      if (v) { if (TOWN.Sky.savedFog) sc.fog = TOWN.Sky.savedFog; }
      else { TOWN.Sky.savedFog = sc.fog; sc.fog = null; }
      sc.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    });

    // free-view
    const fv = $('#set-freeview');
    fv.addEventListener('click', () => {
      enterDiorama();
      closeSettings();
    });
    // screenshot
    $('#set-shot').addEventListener('click', screenshot);
    // close / return
    $('#set-close').addEventListener('click', closeSettings);
    $('#set-return').addEventListener('click', closeSettings);

    syncTime();
  }

  function screenshot() {
    const r = TOWN.Stage.renderer, sc = TOWN.Stage.scene, cam = TOWN.Stage.camera;
    r.render(sc, cam);
    const url = r.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diorama-town-' + timeLabel(TOWN.App.hours).slice(0, 5).replace(':', '') + '.png';
    a.click();
  }

  /* ===========================================================
     Mode transitions
     =========================================================== */
  function showStart() {
    me.mode = 'start';
    me.el.start.classList.remove('hidden');
    me.el.hud.classList.add('hidden');
    me.el.settings.classList.add('hidden');
    document.body.classList.add('game-start');
    document.body.classList.remove('game-play', 'game-diorama');
    // cinematic slow orbit behind the start card
    const o = TOWN.Stage.orbit;
    if (o) { o.enabled = true; o.autoRotate = true; o.autoRotateSpeed = 0.06; o.set(132, 0.85, 0.90, new T.Vector3(0, 5.5, 0), 1200); }
    const p = $('#panel'); if (p) p.style.display = 'none';
    const c = $('#btn-collapse'); if (c) c.style.display = 'none';
  }

  function enterPlay() {
    me.mode = 'play';
    me.el.start.classList.add('hidden');
    me.el.settings.classList.add('hidden');
    me.el.hud.classList.remove('hidden');
    document.body.classList.add('game-play');
    document.body.classList.remove('game-start', 'game-diorama', 'in-diorama');
    const p = $('#panel'); if (p) p.style.display = 'none';
    const c = $('#btn-collapse'); if (c) c.style.display = 'none';
    const o = TOWN.Stage.orbit; if (o) { o.enabled = false; o.autoRotate = false; }
    if (!me.player) spawnPlayer();
    if (me.cam) me.cam.snap();
  }

  function enterDiorama() {
    me.mode = 'diorama';
    me.el.hud.classList.remove('hidden');     // keep topbar for the 1-tap return
    me.el.start.classList.add('hidden');
    me.el.settings.classList.add('hidden');
    document.body.classList.add('game-diorama', 'in-diorama');
    document.body.classList.remove('game-play', 'game-start');
    const p = $('#panel'); if (p) p.style.display = '';
    const c = $('#btn-collapse'); if (c) c.style.display = '';
    const o = TOWN.Stage.orbit;
    if (o) { o.enabled = true; o.autoRotate = false; }
    if (me.player) {
      const pp = me.player.o.position;
      o.set(72, o.sph.theta, 0.9, new T.Vector3(pp.x, pp.y + 3, pp.z), 900);
    }
  }

  function returnToGame() {
    // from diorama back to play
    enterPlay();
  }

  function openSettings() {
    if (me.settingsOpen) return;
    me.preMode = me.mode;
    me.settingsOpen = true;
    me.el.settings.classList.remove('hidden');
    if (me.syncTime) me.syncTime();
    // reflect current toggle states
    const App = TOWN.App;
    const sync = (sel, v) => { const b = $(sel); if (b) b.classList.toggle('on', v); };
    sync('#set-auto', App.auto);
    sync('#set-dyn', App.dynamics);
    sync('#set-shadow', App.shadows);
    sync('#set-fog', App.fogOn);
    document.querySelectorAll('#settings [data-quality]').forEach((b) =>
      b.classList.toggle('on', b.dataset.quality === App.quality));
  }
  function closeSettings() {
    me.settingsOpen = false;
    me.el.settings.classList.add('hidden');
  }
  me.openSettings = openSettings;
  me.closeSettings = closeSettings;

  /* ===========================================================
     Player spawn + input wiring
     =========================================================== */
  /** is (x,z) clear of building footprints (expanded by the player radius)? */
  function clearOfBuildings(x, z) {
    const cols = TOWN.Colliders;
    if (!cols) return true;
    const R = 0.5;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz > (c.r + R) * (c.r + R)) continue;
      const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
      const lx = cos * dx - sin * dz, lz = sin * dx + cos * dz;
      if (Math.abs(lx) < c.w / 2 + R && Math.abs(lz) < c.d / 2 + R) return false;
    }
    return true;
  }

  function findLandSpawn(ox, oz) {
    for (let r = 0; r < 36; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4;
        const x = ox + Math.cos(ang) * r * 1.3;
        const z = oz + Math.sin(ang) * r * 1.3;
        if (Island.sample(x, z).land && clearOfBuildings(x, z)) return { x, z };
      }
    }
    return { x: ox, z: oz };
  }

  function spawnPlayer() {
    const sp = findLandSpawn(5, -4);
    me.player = TOWN.Player.build({ x: sp.x, z: sp.z, seed: 909090, scale: 1.06 });
    TOWN.Stage.scene.add(me.player.o);

    // Build a walkable-mesh list for the player's raycast ground sampler:
    // every static mesh in the scene except the sea dome / sky dome / vehicles
    // / NPC rigs / player rig / small decorative props.  We do this once so
    // the player can step onto stairs, decks, rooftops, piers etc. that
    // Island.sample() (which only knows natural terrain) doesn't see.
    if (!me.groundMeshes) {
      const skip = new Set(['sea', 'seaFar', 'sky', 'dome', 'clouds', 'distant']);
      const list = [];
      const scratchBox = new T.Box3();
      const scratchCenter = new T.Vector3();
      TOWN.Stage.scene.traverse(function (o) {
        if (!o.isMesh) return;
        const n = o.name || '';
        if (skip.has(n)) return;
        // Reject anything that is clearly a movable / small prop: userData.kind
        // marks NPCs / animals / cars / benches; also skip by name keywords.
        const k = o.userData && o.userData.kind;
        if (k === 'pedestrian' || k === 'vehicle' || k === 'ride' || k === 'npc' ||
            k === 'dog' || k === 'cat' || k === 'pigeon' || k === 'peck' ||
            k === 'bench' || k === 'lantern' || k === 'sign') return;
        if (n.indexOf('pigeon') !== -1 || n.indexOf('flock') !== -1) return;
        if (!o.geometry) return;
        if (o === me.player.o) return;
        // Skip meshes that are children of NPC/vehicle groups (their parts
        // have .rigid or .joint but it's cheaper to check parent userData).
        let p = o.parent;
        while (p && p !== TOWN.Stage.scene) {
          const pk = p.userData && p.userData.kind;
          if (pk === 'pedestrian' || pk === 'vehicle' || pk === 'ride') return;
          p = p.parent;
        }
        // Sky-touching filter: if the mesh's world AABB center sits way
        // above the natural terrain at that (x,z) it's a steeple, antenna,
        // bell-tower cap or similar — raycast can't hit it when standing
        // underneath, but stray 5-point cross probes above a wall can and
        // slowly launch the hero.  Rule of thumb: town radius is 62 m so
        // anything whose CENTER is 22 m above terrain at its (x,z) is a
        // high decoration.  Skip to be safe.
        if (o.geometry.boundingBox === null) o.geometry.computeBoundingBox();
        if (o.geometry.boundingBox) {
          scratchBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
          scratchBox.getCenter(scratchCenter);
          const terrH = TOWN.Island.heightAt(scratchCenter.x, scratchCenter.z);
          if (scratchCenter.y > terrH + 22.0) return;
        }
        list.push(o);
      });
      me.groundMeshes = list;
      console.log('[TOWN] walkable meshes:', list.length);
    }
    // Feed the walkable set into Player.groundMeshes so applyMove can raycast
    // against real stair treads / building tops instead of only Island.height.
    TOWN.Player.groundMeshes = me.groundMeshes;

    me.cam = new TOWN.FollowCam(TOWN.Stage.camera, me.player);
    me.cam.snap();

    // wire HUD input
    if (!me.input) {
      const actBtn = (name, hold) => ({
        el: $('.actionpad [data-name="' + name + '"]'), name: name, hold: !!hold,
      });
      me.input = new TOWN.Input({
        joy: $('#joy'), knob: $('#knob'), maxR: 56,
        buttons: [
          actBtn('run', true), actBtn('jump'), actBtn('attack'), actBtn('interact'),
        ],
        cam: $('#scene'),
        onCamRot: (dy, dp) => me.cam && me.cam.rotateBy(dy, dp),
        onZoom: (k) => me.cam && me.cam.zoomBy(k),
      });
    }
  }

  /* ===========================================================
     Dialogue + reaction bubbles
     =========================================================== */
  function openDialogue(npc) {
    if (!npc) {
      flashBubble(me.player ? me.player.o.position : null, '附近没有人可以对话', 1.1, '#set');
      return;
    }
    // face the NPC toward the player (one-time nudge; harmless if overwritten)
    const p = me.player.o.position;
    npc.rotation.y = Math.atan2(p.x - npc.position.x, p.z - npc.position.z);
    me.el.dialogue.classList.remove('hidden');
    $('#dlg-name').textContent = npc.userData.name || '居民';
    $('#dlg-line').textContent = npc.userData.line || LINES[0];
    me._dlgNpc = npc;
  }
  function closeDialogue() {
    me.el.dialogue.classList.add('hidden');
    me._dlgNpc = null;
  }

  /** screen-projected bubble above a world point, for a short time. */
  function flashBubble(worldPos, text, dur, cls) {
    const b = el('div', 'bubble ' + (cls || ''));
    b.textContent = text;
    me.bubbleLayer.appendChild(b);
    me.bubbles.push({ el: b, world: worldPos ? worldPos.clone() : null, t: dur, dur });
  }

  function updateBubbles(dt) {
    const cam = TOWN.Stage.camera;
    for (let i = me.bubbles.length - 1; i >= 0; i--) {
      const b = me.bubbles[i];
      b.t -= dt;
      if (b.t <= 0) { b.el.remove(); me.bubbles.splice(i, 1); continue; }
      if (b.world) {
        // place above the point by ~1.7m
        me.tmp.copy(b.world); me.tmp.y += 1.7;
        me.tmp.project(cam);
        const x = (me.tmp.x * 0.5 + 0.5) * global.innerWidth;
        const y = (-me.tmp.y * 0.5 + 0.5) * global.innerHeight;
        const vis = me.tmp.z < 1;
        b.el.style.transform = 'translate(-50%,-100%) translate(' + x + 'px,' + y + 'px)';
        b.el.style.opacity = vis ? Math.min(1, b.t / 0.4) : 0;
      }
    }
  }

  /* ===========================================================
     Per-frame update (called by app.js when mode === 'play')
     =========================================================== */
  me.update = function (dt, et) {
    if (me.mode !== 'play' || me.settingsOpen) { updateBubbles(dt); return; }
    if (!me.player || !me.cam || !me.input) return;

    me.input.update(dt);
    TOWN.Player.update(me.player, me.input.state, me.cam.camera, dt, et);
    me.cam.update(dt);

    // attack hit → react to nearest NPC
    if (TOWN.Player.shouldHitNow(me.player)) {
      const n = nearestNPC(2.2, Math.PI / 3);
      if (n) {
        TOWN.Player.markHit(me.player);
        flashBubble(n.position.clone(), REACT[(n.userData.npcId || 0) % REACT.length], 1.2, 'react');
      }
    }

    // interact → dialogue (or close an open one)
    if (me.input.state.interactPressed) {
      me.input.consume('interactPressed');
      if (me._dlgNpc) { closeDialogue(); }
      else {
        const n = nearestNPC(2.6, Math.PI / 2);
        openDialogue(n);
      }
    }
    // tap the dialogue to dismiss
    // (the box itself listens; see bindDialogue)

    // consume edges
    if (me.input.state.jumpPressed) me.input.consume('jumpPressed');
    if (me.input.state.attackPressed) {
      if (TOWN.Player.triggerAttack(me.player)) { /* swing started */ }
      me.input.consume('attackPressed');
    }

    // refresh time chip
    const chip = $('#timechip');
    if (chip) chip.textContent = timeLabel(TOWN.App.hours).replace('　', ' ');

    updateBubbles(dt);
  };

  /* ===========================================================
     Bindings (HUD buttons, dialogue tap, keyboard Esc)
     =========================================================== */
  function bindHUD() {
    // start
    $('#btn-start').addEventListener('click', enterPlay);
    $('#btn-start-settings').addEventListener('click', openSettings);
    // gear / timechip / orbit
    $('#hud-gear').addEventListener('click', openSettings);
    const orbitBtn = $('#hud-orbit');
    if (orbitBtn) orbitBtn.addEventListener('click', () => {
      if (me.mode === 'diorama') returnToGame();
      else enterDiorama();
    });
    const chip = $('#timechip'); if (chip) chip.addEventListener('click', openSettings);
    // dialogue tap to dismiss
    me.el.dialogue.addEventListener('click', closeDialogue);
    // Esc toggles settings
    global.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (me.settingsOpen) closeSettings();
        else openSettings();
      }
    });
    // free-view panel buttons (added into #panel by app.js restructure)
    const fvReturn = $('#btn-return-game');
    if (fvReturn) fvReturn.addEventListener('click', returnToGame);
    const fvSettings = $('#btn-panel-settings');
    if (fvSettings) fvSettings.addEventListener('click', openSettings);
  }

  /* ===========================================================
     init — called from app.js once the world is built
     =========================================================== */
  me.init = function () {
    if (me.ready) return;
    me.ready = true;
    buildDOM();
    bindSettings();
    bindHUD();
    collectNPCs();
    showStart();
    // keep the loading screen's removal; nothing else to do
    console.log('[TOWN] game shell ready');
  };

  // helper used by app.js to know whether to run the player loop
  me.isPlayUpdate = function () { return me.mode === 'play' && !me.settingsOpen && me.player; };
})(window);
