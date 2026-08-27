/* =============================================================
   js/game/weapons.js — GTA-03 pistol / aiming / shooting

   GTA-03 scope:
   - one always-equipped pistol while on foot;
   - third-person aim mode + crosshair;
   - semi-auto fire, magazine/reserve ammo and reload;
   - lightweight hit test against town NPCs;
   - shotFired / npcHit mission events.

   No enemy retaliation, wanted level, weapon inventory/switching or deaths.
   ============================================================= */
(function (global) {
  'use strict';

  const T = global.THREE;
  const TOWN = global.TOWN;
  if (!T || !TOWN || !TOWN.Game || !TOWN.Player) return;

  const Game = TOWN.Game;
  const U = TOWN.U;
  const V = TOWN.Vehicles;
  const Missions = TOWN.Missions;

  const W = TOWN.Weapons = {
    version: 'GTA-03.1',
    initialized: false,
    armed: true,
    aiming: false,
    mouseAim: false,
    touchAim: false,
    ammo: 12,
    magSize: 12,
    reserve: 48,
    reloadTime: 1.25,
    reloadTimer: 0,
    fireCooldown: 0,
    fireQueued: false,
    reloadQueued: false,
    recoil: 0,
    hitmarker: 0,
    gun: null,
    muzzle: null,
    hitNPCs: [],
    effects: [],
    els: {},
    mouseAimPointer: -1,
    mouseLastX: 0,
    mouseLastY: 0,
  };

  const tmpDir = new T.Vector3();
  const tmpForward = new T.Vector3();
  const tmpRight = new T.Vector3();
  const tmpEye = new T.Vector3();
  const tmpCam = new T.Vector3();
  const tmpLook = new T.Vector3();
  const tmpOrigin = new T.Vector3();
  const tmpEnd = new T.Vector3();
  const tmpNPC = new T.Vector3();
  const tmpCenter = new T.Vector3();
  const tmpScale = new T.Vector3();

  const RANGE = 70;
  const FIRE_INTERVAL = 0.26;

  function isDriving() {
    return !!(V && V.STATES && V.state === V.STATES.DRIVING);
  }

  function canUseWeapon() {
    return Game.mode === 'play' && !Game.settingsOpen && Game.player && !isDriving() && !Game._dlgNpc;
  }

  function installStyle() {
    if (document.getElementById('gta03-style')) return;
    const s = document.createElement('style');
    s.id = 'gta03-style';
    s.textContent = [
      '#gta03-crosshair{position:fixed;left:50%;top:50%;width:30px;height:30px;transform:translate(-50%,-50%);z-index:160;pointer-events:none;display:none;}',
      '#gta03-crosshair i{position:absolute;background:rgba(255,255,255,.92);box-shadow:0 0 3px rgba(0,0,0,.8);}',
      '#gta03-crosshair i:nth-child(1){width:8px;height:2px;left:0;top:14px}#gta03-crosshair i:nth-child(2){width:8px;height:2px;right:0;top:14px}',
      '#gta03-crosshair i:nth-child(3){width:2px;height:8px;left:14px;top:0}#gta03-crosshair i:nth-child(4){width:2px;height:8px;left:14px;bottom:0}',
      '#gta03-crosshair.hit:after,#gta03-crosshair.hit:before{content:"";position:absolute;left:7px;top:14px;width:16px;height:2px;background:#fff;transform:rotate(45deg);box-shadow:0 0 4px rgba(255,70,55,.95);}',
      '#gta03-crosshair.hit:after{transform:rotate(-45deg)}',
      '#gta03-ammo{position:fixed;right:18px;top:76px;z-index:158;min-width:106px;text-align:right;padding:8px 10px;border-radius:8px;background:rgba(5,8,10,.68);border:1px solid rgba(255,255,255,.16);color:#fff;font:700 16px/1.05 ui-monospace,monospace;display:none;pointer-events:none}',
      '#gta03-ammo small{display:block;margin-top:4px;color:rgba(255,255,255,.62);font:600 9px/1 system-ui,sans-serif;letter-spacing:.10em}',
      '.gta03-action{position:fixed;z-index:159;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(12,16,20,.72);color:#fff;font:700 11px/1 system-ui,-apple-system,sans-serif;width:58px;height:58px;display:none;touch-action:none}',
      '#gta03-aim{right:22px;bottom:186px}#gta03-reload{right:92px;bottom:186px}',
      '#gta03-aim.active{border-color:#ffd21a;color:#ffd21a;background:rgba(45,38,8,.80)}',
      '@media(max-width:700px){#gta03-ammo{right:10px;top:66px}#gta03-aim{right:16px;bottom:174px}#gta03-reload{right:82px;bottom:174px}.gta03-action{width:54px;height:54px;font-size:10px}}'
    ].join('');
    document.head.appendChild(s);
  }

  function installDOM() {
    const cross = document.createElement('div');
    cross.id = 'gta03-crosshair';
    cross.innerHTML = '<i></i><i></i><i></i><i></i>';
    document.body.appendChild(cross);
    W.els.crosshair = cross;

    const ammo = document.createElement('div');
    ammo.id = 'gta03-ammo';
    document.body.appendChild(ammo);
    W.els.ammo = ammo;

    const aim = document.createElement('button');
    aim.id = 'gta03-aim';
    aim.className = 'gta03-action';
    aim.type = 'button';
    aim.textContent = '瞄准';
    aim.addEventListener('pointerdown', function (e) {
      if (!canUseWeapon()) return;
      e.preventDefault();
      e.stopPropagation();
      W.touchAim = !W.touchAim;
      syncAimState();
    });
    document.body.appendChild(aim);
    W.els.aim = aim;

    const reload = document.createElement('button');
    reload.id = 'gta03-reload';
    reload.className = 'gta03-action';
    reload.type = 'button';
    reload.textContent = '换弹';
    reload.addEventListener('pointerdown', function (e) {
      if (!canUseWeapon()) return;
      e.preventDefault();
      e.stopPropagation();
      W.reloadQueued = true;
    });
    document.body.appendChild(reload);
    W.els.reload = reload;
  }

  function syncAimState() {
    W.aiming = !!(W.mouseAim || W.touchAim);
    if (W.els.aim) W.els.aim.classList.toggle('active', W.aiming);
  }

  function clearAim() {
    W.mouseAim = false;
    W.touchAim = false;
    W.mouseAimPointer = -1;
    syncAimState();
  }

  function gunIcon() {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h10.5l3-2.4 2.5 1.2-2 3.2h-4l-1 3.3H9.8L9 12H4z"/><path d="M10 15.3 9.2 20H6.6L6 12"/></svg>';
  }

  function syncAttackButton() {
    const b = document.querySelector('.actionpad [data-name="attack"]');
    if (!b || isDriving()) return;
    if (b.dataset.gta03 !== '1') {
      b.innerHTML = gunIcon();
      b.title = '射击';
      b.dataset.gta03 = '1';
    }
  }

  function buildPistol() {
    const g = new T.Group();
    g.name = 'gta03-pistol';
    const dark = new T.MeshStandardMaterial({ color: 0x20242a, roughness: 0.42, metalness: 0.55 });
    const gripMat = new T.MeshStandardMaterial({ color: 0x332c28, roughness: 0.84, metalness: 0.02 });
    const slide = new T.Mesh(new T.BoxGeometry(0.10, 0.095, 0.34), dark);
    slide.position.set(0, 0.02, 0.10);
    g.add(slide);
    const barrel = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 0.26, 8), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, 0.20);
    g.add(barrel);
    const grip = new T.Mesh(new T.BoxGeometry(0.09, 0.23, 0.11), gripMat);
    grip.position.set(0, -0.12, -0.02);
    grip.rotation.x = -0.18;
    g.add(grip);
    const guard = new T.Mesh(new T.TorusGeometry(0.055, 0.012, 5, 10, Math.PI), dark);
    guard.rotation.z = Math.PI / 2;
    guard.rotation.y = Math.PI / 2;
    guard.position.set(0, -0.06, 0.06);
    g.add(guard);
    const muzzle = new T.Object3D();
    muzzle.name = 'gta03-muzzle';
    muzzle.position.set(0, 0.01, 0.37);
    g.add(muzzle);
    g.userData.muzzle = muzzle;
    g.traverse(function (o) { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    return g;
  }

  function ensureGun() {
    if (!Game.player || !Game.player.limbs || !Game.player.limbs[3]) return;
    if (W.gun && W.gun.parent) return;
    const arm = Game.player.limbs[3];
    const gun = buildPistol();
    gun.position.set(0, -0.54, 0.055);
    arm.add(gun);
    W.gun = gun;
    W.muzzle = gun.userData.muzzle;
  }

  function setGunVisible(v) {
    if (W.gun) W.gun.visible = !!v;
  }

  function aimBasis() {
    const camCtl = Game.cam;
    let yaw;
    let pitch = 0;
    if (camCtl && isFinite(camCtl.curYaw)) {
      yaw = camCtl.curYaw + Math.PI;
      if (isFinite(camCtl.curPitch)) pitch = (0.62 - camCtl.curPitch) * 0.82;
    } else {
      TOWN.Stage.camera.getWorldDirection(tmpDir);
      yaw = Math.atan2(tmpDir.x, tmpDir.z);
      pitch = Math.asin(U.clamp(tmpDir.y, -0.8, 0.8));
    }
    const cp = Math.cos(pitch);
    tmpForward.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp).normalize();
    tmpRight.set(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
    return yaw;
  }

  function applyAimCamera(dt) {
    if (!W.aiming || !Game.player || !TOWN.Stage.camera) return;
    const st = Game.player;
    const yaw = aimBasis();
    st.yaw = yaw;
    st.moveYaw = yaw;
    st.o.rotation.y = yaw;

    tmpEye.set(st.o.position.x, st.o.position.y + st.height * 0.84, st.o.position.z);
    tmpCam.copy(tmpEye)
      .addScaledVector(tmpForward, -3.25)
      .addScaledVector(tmpRight, 0.70);
    tmpCam.y += 0.36;
    tmpLook.copy(tmpEye).addScaledVector(tmpForward, 35);

    const cam = TOWN.Stage.camera;
    cam.position.lerp(tmpCam, Math.min(1, dt * 15));
    cam.lookAt(tmpLook);
  }

  function applyWeaponPose() {
    if (!Game.player || !Game.player.limbs) return;
    const st = Game.player;
    const armR = st.limbs[3];
    const armL = st.limbs[2];
    if (!armR) return;

    if (W.aiming) {
      const kick = W.recoil > 0 ? (W.recoil / 0.12) * 0.16 : 0;
      armR.rotation.x = -1.38 + kick;
      armR.rotation.z = -0.05;
      if (armL) {
        armL.rotation.x = -0.88;
        armL.rotation.z = 0.10;
      }
      if (st.torso) {
        st.torso.rotation.y = 0;
        st.torso.rotation.z *= 0.25;
      }
    } else if (W.recoil > 0) {
      armR.rotation.x = -0.92 + (W.recoil / 0.12) * 0.12;
      armR.rotation.z = -0.04;
    }

    if (W.gun) W.gun.rotation.x = -armR.rotation.x;
    st.o.updateMatrixWorld(true);
  }

  function raySphere(origin, dir, center, radius) {
    const ox = origin.x - center.x;
    const oy = origin.y - center.y;
    const oz = origin.z - center.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const h = b * b - c;
    if (h < 0) return Infinity;
    const s = Math.sqrt(h);
    const t0 = -b - s;
    const t1 = -b + s;
    if (t0 > 0.02) return t0;
    return t1 > 0.02 ? t1 : Infinity;
  }

  function colliderDistance(origin, dir, maxRange) {
    const cols = TOWN.Colliders || [];
    let best = maxRange;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c || !isFinite(c.x) || !isFinite(c.z) || !isFinite(c.w) || !isFinite(c.d)) continue;
      const co = Math.cos(c.rot || 0), si = Math.sin(c.rot || 0);
      const dx = origin.x - c.x, dz = origin.z - c.z;
      const ox = co * dx - si * dz;
      const oz = si * dx + co * dz;
      const vx = co * dir.x - si * dir.z;
      const vz = si * dir.x + co * dir.z;
      const hw = c.w * 0.5, hd = c.d * 0.5;
      let tmin = 0, tmax = best;

      if (Math.abs(vx) < 1e-7) {
        if (ox < -hw || ox > hw) continue;
      } else {
        let a = (-hw - ox) / vx, b = (hw - ox) / vx;
        if (a > b) { const q = a; a = b; b = q; }
        tmin = Math.max(tmin, a); tmax = Math.min(tmax, b);
        if (tmin > tmax) continue;
      }
      if (Math.abs(vz) < 1e-7) {
        if (oz < -hd || oz > hd) continue;
      } else {
        let a = (-hd - oz) / vz, b = (hd - oz) / vz;
        if (a > b) { const q = a; a = b; b = q; }
        tmin = Math.max(tmin, a); tmax = Math.min(tmax, b);
        if (tmin > tmax) continue;
      }
      if (tmax >= 0 && tmin < best) best = Math.max(0.03, tmin);
    }
    return best;
  }

  function findNPCHit(origin, dir, maxRange) {
    const list = Game.npcs || [];
    let best = null;
    let bestT = maxRange;
    for (let i = 0; i < list.length; i++) {
      const npc = list[i];
      if (!npc || !npc.visible) continue;
      npc.getWorldPosition(tmpNPC);
      npc.getWorldScale(tmpScale);
      const sc = Math.max(0.65, Math.min(1.35, Math.max(tmpScale.x, tmpScale.y, tmpScale.z)));

      tmpCenter.set(tmpNPC.x, tmpNPC.y + 0.92 * sc, tmpNPC.z);
      let t = raySphere(origin, dir, tmpCenter, 0.37 * sc);
      tmpCenter.set(tmpNPC.x, tmpNPC.y + 1.53 * sc, tmpNPC.z);
      const th = raySphere(origin, dir, tmpCenter, 0.22 * sc);
      if (th < t) t = th;
      if (t < bestT) {
        bestT = t;
        best = npc;
      }
    }
    return best ? { npc: best, distance: bestT } : null;
  }

  function addLineEffect(a, b, color, life) {
    const geo = new T.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.88, depthWrite: false });
    const line = new T.Line(geo, mat);
    line.renderOrder = 8;
    TOWN.Stage.scene.add(line);
    W.effects.push({ o: line, t: life || 0.07, max: life || 0.07, dispose: true });
  }

  function addFlash(pos) {
    const mat = new T.MeshBasicMaterial({ color: 0xffd38a, transparent: true, opacity: 0.95, depthWrite: false });
    const m = new T.Mesh(new T.SphereGeometry(0.075, 6, 4), mat);
    m.position.copy(pos);
    TOWN.Stage.scene.add(m);
    W.effects.push({ o: m, t: 0.055, max: 0.055, dispose: true });
  }

  function addImpact(pos, hit) {
    const mat = new T.MeshBasicMaterial({ color: hit ? 0xff6655 : 0xffd38a, transparent: true, opacity: 0.86, depthWrite: false });
    const m = new T.Mesh(new T.SphereGeometry(hit ? 0.055 : 0.035, 6, 4), mat);
    m.position.copy(pos);
    TOWN.Stage.scene.add(m);
    W.effects.push({ o: m, t: hit ? 0.11 : 0.07, max: hit ? 0.11 : 0.07, dispose: true });
  }

  function registerNPCHit(npc, point) {
    let rec = null;
    for (let i = 0; i < W.hitNPCs.length; i++) {
      if (W.hitNPCs[i].npc === npc) { rec = W.hitNPCs[i]; break; }
    }
    if (!rec) {
      rec = { npc: npc, t: 0, baseZ: npc.rotation.z || 0 };
      W.hitNPCs.push(rec);
    }
    rec.t = 0.28;
    rec.baseZ = npc.rotation.z || 0;
    npc.userData.gta03Hits = (npc.userData.gta03Hits || 0) + 1;
    W.hitmarker = 0.14;

    if (Missions && Missions.emit) {
      Missions.emit('npcHit', {
        npc: npc,
        npcId: npc.userData.npcId,
        weapon: 'pistol',
        position: point.clone(),
        hits: npc.userData.gta03Hits,
      });
    }
  }

  function shotDirection() {
    if (W.aiming) {
      TOWN.Stage.camera.getWorldDirection(tmpDir);
      tmpDir.normalize();
    } else {
      const yaw = Game.player ? Game.player.yaw : 0;
      tmpDir.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    }
    return tmpDir;
  }

  function muzzleOrigin() {
    if (W.muzzle && W.gun && W.gun.visible) {
      W.muzzle.getWorldPosition(tmpOrigin);
      return tmpOrigin;
    }
    const st = Game.player;
    tmpOrigin.set(st.o.position.x, st.o.position.y + st.height * 0.76, st.o.position.z);
    return tmpOrigin;
  }

  function startReload() {
    if (W.reloadTimer > 0 || W.ammo >= W.magSize || W.reserve <= 0 || !canUseWeapon()) return false;
    W.reloadTimer = W.reloadTime;
    return true;
  }

  function finishReload() {
    const need = W.magSize - W.ammo;
    const take = Math.min(need, W.reserve);
    W.ammo += take;
    W.reserve -= take;
  }

  function fire() {
    if (!canUseWeapon() || W.reloadTimer > 0 || W.fireCooldown > 0) return false;
    if (W.ammo <= 0) {
      startReload();
      return false;
    }

    W.ammo--;
    W.fireCooldown = FIRE_INTERVAL;
    W.recoil = 0.12;

    const origin = muzzleOrigin().clone();
    const dir = shotDirection().clone();
    const wallT = colliderDistance(origin, dir, RANGE);
    const hit = findNPCHit(origin, dir, wallT);
    const endT = hit ? hit.distance : wallT;
    tmpEnd.copy(origin).addScaledVector(dir, endT);

    addFlash(origin);
    addLineEffect(origin, tmpEnd, hit ? 0xffe3ad : 0xffd38a, 0.065);
    addImpact(tmpEnd, !!hit);

    if (hit) registerNPCHit(hit.npc, tmpEnd);

    if (Missions && Missions.emit) {
      Missions.emit('shotFired', {
        weapon: 'pistol',
        position: origin.clone(),
        direction: dir.clone(),
        hitNPC: hit ? hit.npc : null,
      });
    }
    return true;
  }

  function updateTimers(dt) {
    W.fireCooldown = Math.max(0, W.fireCooldown - dt);
    W.recoil = Math.max(0, W.recoil - dt);
    W.hitmarker = Math.max(0, W.hitmarker - dt);
    if (W.reloadTimer > 0) {
      const before = W.reloadTimer;
      W.reloadTimer = Math.max(0, W.reloadTimer - dt);
      if (before > 0 && W.reloadTimer === 0) finishReload();
    }
  }

  function updateNPCReactions(dt) {
    for (let i = W.hitNPCs.length - 1; i >= 0; i--) {
      const r = W.hitNPCs[i];
      if (!r.npc) { W.hitNPCs.splice(i, 1); continue; }
      r.t -= dt;
      if (r.t <= 0) {
        r.npc.rotation.z = r.baseZ;
        W.hitNPCs.splice(i, 1);
      } else {
        const k = r.t / 0.28;
        r.npc.rotation.z = r.baseZ + Math.sin((1 - k) * Math.PI * 2.2) * 0.10 * k;
      }
    }
  }

  function updateEffects(dt) {
    for (let i = W.effects.length - 1; i >= 0; i--) {
      const e = W.effects[i];
      e.t -= dt;
      if (e.o && e.o.material && e.max > 0) e.o.material.opacity = Math.max(0, e.t / e.max) * 0.88;
      if (e.t > 0) continue;
      if (e.o && e.o.parent) e.o.parent.remove(e.o);
      if (e.dispose && e.o) {
        if (e.o.geometry && e.o.geometry.dispose) e.o.geometry.dispose();
        if (e.o.material && e.o.material.dispose) e.o.material.dispose();
      }
      W.effects.splice(i, 1);
    }
  }

  function syncHUD() {
    const active = canUseWeapon();
    if (W.els.ammo) {
      W.els.ammo.style.display = active ? 'block' : 'none';
      const status = W.reloadTimer > 0 ? '换弹中 ' + W.reloadTimer.toFixed(1) + 's' : '手枪';
      W.els.ammo.innerHTML = W.ammo + ' / ' + W.reserve + '<small>' + status + '</small>';
    }
    if (W.els.aim) W.els.aim.style.display = active ? 'block' : 'none';
    if (W.els.reload) W.els.reload.style.display = active ? 'block' : 'none';
    if (W.els.crosshair) {
      W.els.crosshair.style.display = active && W.aiming ? 'block' : 'none';
      W.els.crosshair.classList.toggle('hit', W.hitmarker > 0);
    }
    if (W.els.aim) W.els.aim.classList.toggle('active', W.aiming);
  }

  function installInput() {
    const canvas = document.getElementById('scene');
    if (!canvas) return;

    canvas.addEventListener('contextmenu', function (e) {
      if (canUseWeapon()) e.preventDefault();
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!canUseWeapon()) return;
      if (e.pointerType === 'mouse' && e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        W.mouseAim = true;
        W.mouseAimPointer = e.pointerId;
        W.mouseLastX = e.clientX;
        W.mouseLastY = e.clientY;
        syncAimState();
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        }
      } else if (e.pointerType === 'mouse' && e.button === 0 && W.aiming) {
        e.preventDefault();
        e.stopPropagation();
        W.fireQueued = true;
      }
    }, true);

    global.addEventListener('pointermove', function (e) {
      if (!W.mouseAim || e.pointerId !== W.mouseAimPointer || !canUseWeapon()) return;
      const dx = e.clientX - W.mouseLastX;
      const dy = e.clientY - W.mouseLastY;
      W.mouseLastX = e.clientX;
      W.mouseLastY = e.clientY;
      if (Game.cam && Game.cam.rotateBy) Game.cam.rotateBy(-dx * 0.0045, dy * 0.0038);
    }, true);

    const endAim = function (e) {
      if (e.pointerId !== W.mouseAimPointer) return;
      W.mouseAim = false;
      W.mouseAimPointer = -1;
      syncAimState();
    };
    global.addEventListener('pointerup', endAim, true);
    global.addEventListener('pointercancel', endAim, true);

    global.addEventListener('keydown', function (e) {
      if (!canUseWeapon() || e.repeat) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'r') {
        e.preventDefault();
        W.reloadQueued = true;
      }
    });
  }

  W.init = function () {
    if (W.initialized) return;
    W.initialized = true;
    installStyle();
    installDOM();
    installInput();
    console.log('[GTA-03] pistol system ready');
  };

  const originalInit = Game.init;
  Game.init = function () {
    const out = originalInit.apply(Game, arguments);
    W.init();
    return out;
  };

  const originalUpdate = Game.update;
  Game.update = function (dt, elapsed) {
    if (!W.initialized) W.init();

    // Consume the existing attack edge before shell.js can turn it into melee.
    // While driving, GTA-02 owns this button as the brake and we leave it alone.
    const beforeOnFoot = canUseWeapon();
    const input = Game.input;
    if (beforeOnFoot && input && input.state) {
      if (input.state.attackPressed) {
        if (input.consume) input.consume('attackPressed');
        else input.state.attackPressed = false;
        W.fireQueued = true;
      }
      // If this interact is about to enter a nearby car, hide the held pistol
      // before GTA-02B clones the driver visual into the cabin.
      if (input.state.interactPressed && V && V.nearest && V.nearest(2.8)) setGunVisible(false);
    }

    const out = originalUpdate.call(Game, dt, elapsed);

    updateTimers(dt);
    updateNPCReactions(dt);
    updateEffects(dt);

    if (!canUseWeapon()) {
      clearAim();
      setGunVisible(false);
      W.fireQueued = false;
      W.reloadQueued = false;
      syncHUD();
      return out;
    }

    ensureGun();
    setGunVisible(true);
    syncAttackButton();

    if (W.reloadQueued) {
      startReload();
      W.reloadQueued = false;
    }

    if (W.aiming) applyAimCamera(dt);
    applyWeaponPose();

    if (W.fireQueued) {
      fire();
      W.fireQueued = false;
    }

    syncHUD();
    return out;
  };

  W.fire = function () { W.fireQueued = true; };
  W.reload = function () { W.reloadQueued = true; };
  W.setAim = function (v) { W.touchAim = !!v; syncAimState(); };
})(window);
