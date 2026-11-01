// Pointer-lock first-person controls with the same collision step the server uses.
import { CFG } from '../shared/constants.js';
import { stepPlayer } from '../shared/map.js';

const SENS = 0.0021;
const KEY_YAW = 2.6, KEY_PITCH = 1.7;   // radians per second while a look key is held

export class Controls {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;
    this.pos = { x: 0, y: 0, z: 0, vy: 0, onGround: true };
    this.locked = false;
    this.enabled = false;        // false while dead or between rounds: look only, no walking
    this.onDigit = null; this.onBackspace = null; this.onGadget = null; this.onTab = null; this.onLockChange = null;
    this.jumpQueued = false;
    this.touchMove = { x: 0, y: 0 };   // joystick vector from touch.js: x right, y forward, each -1..1
    this.keyLook = false;              // true: WASD turns the view and the arrow keys walk (trackpad friendly)
    // ?nolock: automated tests drive the game without a real pointer lock.
    this.noLock = new URLSearchParams(location.search).has('nolock') || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches);
    if (this.noLock) this.locked = true;

    document.addEventListener('pointerlockchange', () => {
      if (this.noLock) return;
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw -= e.movementX * SENS;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * SENS));
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    });
    document.addEventListener('keydown', e => {
      if (!this.locked) return;
      if (e.repeat) { if (e.code === 'Tab') e.preventDefault(); return; }
      const c = e.code;
      if (c === 'Tab') { e.preventDefault(); this.onTab?.(true); return; }
      if (/^(Digit|Numpad)\d$/.test(c)) { e.preventDefault(); this.onDigit?.(c.slice(-1)); return; }
      if (c === 'Backspace' || c === 'Delete') { e.preventDefault(); this.onBackspace?.(); return; }
      for (const [kind, g] of Object.entries(CFG.GADGETS)) if (c === 'Key' + g.key) { this.onGadget?.(kind); return; }
      if (c === 'Space') { e.preventDefault(); this.jumpQueued = true; }
      this.keys.add(c);
    });
    document.addEventListener('keyup', e => {
      if (e.code === 'Tab') { e.preventDefault(); this.onTab?.(false); }
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  requestLock() {
    if (this.locked || this.noLock) return;
    try { const p = this.canvas.requestPointerLock({ unadjustedMovement: true }); p?.catch?.(() => this.canvas.requestPointerLock()); }
    catch { this.canvas.requestPointerLock(); }
  }
  releaseLock() { if (this.locked && !this.noLock) document.exitPointerLock(); }

  teleport(p, yaw, resetPitch = false) {
    this.pos = { x: p[0], y: p[1], z: p[2], vy: 0, onGround: true };
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (resetPitch) this.pitch = 0;
  }

  update(dt, map) {
    if (!map) return;
    let fx = 0, fz = 0;
    const k = this.keys;
    if (this.locked && this.keyLook) {
      const turn = (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
      const tilt = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      this.yaw += turn * KEY_YAW * dt;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + tilt * KEY_PITCH * dt));
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }
    if (this.enabled && this.locked) {
      const wasd = !this.keyLook;
      let f = ((wasd && k.has('KeyW')) || k.has('ArrowUp') ? 1 : 0) - ((wasd && k.has('KeyS')) || k.has('ArrowDown') ? 1 : 0);
      let r = ((wasd && k.has('KeyD')) || k.has('ArrowRight') ? 1 : 0) - ((wasd && k.has('KeyA')) || k.has('ArrowLeft') ? 1 : 0);
      if (!f && !r) { f = this.touchMove.y; r = this.touchMove.x; }     // analog stick: partial deflection walks slower
      const len = Math.max(1, Math.hypot(f, r));
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
      fx = ((-sy * f) + (cy * r)) / len * CFG.WALK_SPEED;
      fz = ((-cy * f) + (-sy * r)) / len * CFG.WALK_SPEED;
    }
    const jump = this.enabled && this.jumpQueued;
    this.jumpQueued = false;
    stepPlayer(this.pos, fx, fz, dt, map, { jump });
  }
}
