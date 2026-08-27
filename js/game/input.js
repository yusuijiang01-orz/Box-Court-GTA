/* =============================================================
   js/game/input.js — TOWN.Input

   Touch-first controls for a mobile third-person game:
     · left joystick  -> move (camera-relative)
     · right buttons  -> run (hold), jump, attack, interact
     · drag elsewhere -> orbit camera  · pinch/wheel -> zoom
   Keyboard mirrors everything for desktop testing:
     WASD / arrows move, Shift run, Space jump, J attack,
     E interact, mouse-drag orbit, wheel zoom.
   ============================================================= */
(function (global) {
  'use strict';
  const TOWN = global.TOWN;
  const U = TOWN.U;

  /**
   * new TOWN.Input(opts)
   * opts: { joy, base, knob, maxR, buttons:[{el,name,...}], cam:canvas,
   *         onCamRot(dyaw,dpitch), onZoom(k), onAction(name, pressed) }
   * Reads pointer/touch/keyboard events and fills `this.state`.
   */
  function Input(opts) {
    opts = opts || {};
    const self = this;

    // public state, read by the player controller each frame
    this.state = {
      move: { x: 0, y: 0 },   // y>0 = forward
      run: false,
      jumpPressed: false,     // edge (consumed by player)
      attackPressed: false,   // edge
      interactPressed: false, // edge
    };

    // ---- joystick ----
    this.joy = opts.joy;
    this.base = opts.base;
    this.knob = opts.knob;
    this.maxR = opts.maxR || 58;
    this._joy = { id: -1, cx: 0, cy: 0, active: false };

    // ---- action buttons ----
    this.buttons = opts.buttons || [];
    this._held = {};          // name -> true while held

    // ---- camera drag ----
    this.cam = opts.cam;
    this.onCamRot = opts.onCamRot || function () {};
    this.onZoom = opts.onZoom || function () {};
    this._cam = { id: -1, lx: 0, ly: 0 };
    this._pinch = { active: false, d: 0 };

    this.onAction = opts.onAction || function () {};

    this._install();
  }

  Input.prototype._install = function () {
    const self = this;
    const st = self.state;

    // ---------- joystick ----------
    if (self.joy) {
      const start = (e) => {
        if (self._joy.id !== -1) return;
        self._joy.id = e.pointerId;
        self._joy.active = true;
        const r = self.joy.getBoundingClientRect();
        self._joy.cx = r.left + r.width / 2;
        self._joy.cy = r.top + r.height / 2;
        self.joy.setPointerCapture && self.joy.setPointerCapture(e.pointerId);
        self._move(e);
        e.preventDefault();
      };
      const move = (e) => { if (e.pointerId === self._joy.id) self._move(e); };
      const end = (e) => {
        if (e.pointerId !== self._joy.id) return;
        self._joy.id = -1; self._joy.active = false;
        st.move.x = 0; st.move.y = 0;
        if (self.knob) { self.knob.style.transform = 'translate(-50%,-50%)'; }
        self.joy.classList.remove('active');
      };
      self._move = function (e) {
        let dx = e.clientX - self._joy.cx;
        let dy = e.clientY - self._joy.cy;
        const d = Math.hypot(dx, dy);
        const R = self.maxR;
        if (d > R) { dx = dx / d * R; dy = dy / d * R; }
        // screen y is down -> invert for "forward"
        st.move.x = dx / R;
        st.move.y = -dy / R;
        if (self.knob) {
          self.knob.style.transform =
            'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
        }
        self.joy.classList.add('active');
      };
      self.joy.addEventListener('pointerdown', start);
      global.addEventListener('pointermove', move);
      global.addEventListener('pointerup', end);
      global.addEventListener('pointercancel', end);
    }

    // ---------- action buttons ----------
    self.buttons.forEach((b) => {
      if (!b.el) return;
      const name = b.name;
      const isHold = !!b.hold;          // run is hold; others are tap
      const down = (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.el.classList.add('active');
        if (isHold) { self._held[name] = true; st[name] = true; }
        else {
          if (name === 'jump') st.jumpPressed = true;
          else if (name === 'attack') st.attackPressed = true;
          else if (name === 'interact') st.interactPressed = true;
        }
        self.onAction(name, true);
      };
      const up = (e) => {
        if (isHold) { self._held[name] = false; st[name] = false; }
        b.el.classList.remove('active');
        self.onAction(name, false);
      };
      b.el.addEventListener('pointerdown', down);
      global.addEventListener('pointerup', up);
      global.addEventListener('pointercancel', up);
    });

    // ---------- camera drag + pinch ----------
    if (self.cam) {
      const camDown = (e) => {
        // ignore drags that start on a UI control
        if (e.target && self._isUI(e.target)) return;
        if (self._cam.id !== -1) return;
        self._cam.id = e.pointerId;
        self._cam.lx = e.clientX; self._cam.ly = e.clientY;
      };
      const camMove = (e) => {
        if (e.pointerId !== self._cam.id) return;
        const dx = e.clientX - self._cam.lx, dy = e.clientY - self._cam.ly;
        self._cam.lx = e.clientX; self._cam.ly = e.clientY;
        // map pixels to radians: ~0.005 rad/px yaw, 0.004 pitch (inverted)
        self.onCamRot(-dx * 0.005, dy * 0.004);
      };
      const camUp = (e) => { if (e.pointerId === self._cam.id) self._cam.id = -1; };
      self._isUI = function (t) {
        return !!(t && t.closest && t.closest(
          'button, .joy, .joy-knob, .hud-btn, .actionpad, #start-screen, #settings, #dialogue, #panel, #btn-collapse, .topbar, .bubble-layer'));
      };
      self.cam.addEventListener('pointerdown', camDown);
      global.addEventListener('pointermove', camMove);
      global.addEventListener('pointerup', camUp);
      global.addEventListener('pointercancel', camUp);
      // wheel zoom (desktop)
      self.cam.addEventListener('wheel', (e) => {
        e.preventDefault();
        const k = Math.exp(U.clamp(e.deltaY, -220, 220) * 0.0016);
        self.onZoom(k);
      }, { passive: false });
      // pinch zoom (touch)
      self.cam.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          self._pinch.active = true;
          self._pinch.d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY);
        }
      }, { passive: true });
      self.cam.addEventListener('touchmove', (e) => {
        if (self._pinch.active && e.touches.length === 2) {
          e.preventDefault();
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY);
          if (self._pinch.d > 0) self.onZoom(self._pinch.d / d);
          self._pinch.d = d;
        }
      }, { passive: false });
      self.cam.addEventListener('touchend', () => { self._pinch.active = false; });
    }

    // ---------- keyboard (desktop) ----------
    const keys = self._keys = {};
    self._onKeyDown = (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      keys[k] = true;
      if (k === ' ') { st.jumpPressed = true; e.preventDefault(); }
      else if (k === 'j') st.attackPressed = true;
      else if (k === 'e' || k === 'f') st.interactPressed = true;
      else if (k === 'shift') st.run = true;
      else if (k === 'v') st.toggleDebug = true;   // edge consumed by Player
    };
    self._onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      keys[k] = false;
      if (k === 'shift') st.run = false;
    };
    // combine keyboard move into the joystick vector each frame.
    // NOTE: when keys are ALL released we must still overwrite st.move so
    // a stale joystick value from a previous drag cannot linger.
    self._kbdMove = function () {
      let kx = 0, ky = 0;
      if (keys['w'] || keys['arrowup']) ky += 1;
      if (keys['s'] || keys['arrowdown']) ky -= 1;
      if (keys['a'] || keys['arrowleft']) kx -= 1;
      if (keys['d'] || keys['arrowright']) kx += 1;
      const pressed = !!(kx || ky);
      // keyboard takes priority when any WASD/arrow key is down, otherwise
      // we trust the joystick. But Shift-run clears regardless (on release).
      if (pressed) {
        const m = Math.hypot(kx, ky) || 1;
        st.move.x = kx / m;
        st.move.y = ky / m;
        if (keys['shift']) st.run = true;
      }
      if (!keys['shift']) st.run = false;
    };
    global.addEventListener('keydown', self._onKeyDown);
    global.addEventListener('keyup', self._onKeyUp);
    // final catch-all: the user switches app tab or background -> clear all
    self._onLoseFocus = function () {
      for (const k in keys) keys[k] = false;
      self._joy.id = -1; self._joy.active = false;
      st.move.x = 0; st.move.y = 0;
      st.run = false;
      if (self.knob) self.knob.style.transform = 'translate(-50%,-50%)';
      if (self.joy) self.joy.classList.remove('active');
      for (let i = 0; i < self.buttons.length; i++) {
        const b = self.buttons[i]; if (b && b.el) b.el.classList.remove('active');
      }
    };
    global.addEventListener('blur', self._onLoseFocus);
    if (global.document) {
      global.document.addEventListener('visibilitychange', () => {
        if (global.document.visibilityState !== 'visible') self._onLoseFocus();
      });
    }
  };

  /** pre-step(dt): fold keyboard into move if joystick isn't being used. */
  Input.prototype.update = function (dt) {
    // Safety reset: if the joy was flagged inactive but the state still holds a
    // non-zero value (missed pointerup / focus loss), clear it now.
    if (!this._joy.active && !this._kbdMoveHasKeys()) {
      // zero only if not driven by _kbdMove
      this.state.move.x = 0; this.state.move.y = 0;
    }
    this._kbdMove();
  };

  /** _kbdMoveHasKeys() — any WASD/arrow currently held? */
  Input.prototype._kbdMoveHasKeys = function () {
    const k = this._keys || {};
    return !!(k['w'] || k['a'] || k['s'] || k['d'] ||
              k['arrowup'] || k['arrowdown'] || k['arrowleft'] || k['arrowright']);
  };

  /** consume an edge flag (call once the player has reacted). */
  Input.prototype.consume = function (name) {
    this.state[name] = false;
  };

  Input.prototype.dispose = function () {
    global.removeEventListener('keydown', this._onKeyDown);
    global.removeEventListener('keyup', this._onKeyUp);
    global.removeEventListener('blur', this._onLoseFocus);
  };

  TOWN.Input = Input;
  console.log('[TOWN] input ready');
})(window);
