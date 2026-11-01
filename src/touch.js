// Touch controls for phones and tablets: a floating joystick on the left half, drag-to-look on the
// right half, a digit keypad, jump and gadget buttons. Feeds the same Controls object the keyboard
// and mouse use, so the game logic never knows the difference.
import { CFG } from '../shared/constants.js';

const LOOK_SENS = 0.0045;      // radians per CSS pixel
const STICK_RADIUS = 46;       // px the knob can travel

export function isTouchDevice() {
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
}

export class TouchUI {
  constructor(controls, { onMenu, onBoard }) {
    this.controls = controls;
    this.root = document.getElementById('touch');
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="tzone left" id="tMove"><div class="stick" id="stick" hidden><div class="knob"></div></div></div>
      <div class="tzone right" id="tLook"></div>
      <div class="tbar top">
        <button class="tbtn" id="tMenu" aria-label="Menu">☰</button>
        <button class="tbtn" id="tBoard" aria-label="Scoreboard">≡</button>
      </div>
      <div class="tgadgets" id="tGadgets"></div>
      <button class="tbtn jump" id="tJump" aria-label="Jump">⤒</button>
      <div class="keypad" id="keypad"></div>`;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '·'];
    document.getElementById('keypad').innerHTML = keys.map(k =>
      k === '·' ? '<span></span>' : `<button class="key${k === '⌫' ? ' back' : ''}" data-k="${k}">${k}</button>`).join('');
    document.getElementById('tGadgets').innerHTML = Object.entries(CFG.GADGETS).map(([k, g]) =>
      `<button class="tbtn gadget" data-kind="${k}"><div class="cd"></div><span>${g.label}</span></button>`).join('');

    // Game actions fire on pointerdown for zero latency; menu-ish buttons fire on click so an
    // overlay that appears under the finger does not swallow the release as a second tap.
    const press = (el, fn, onClick = false) => {
      el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); if (!onClick) fn(e); });
      if (onClick) el.addEventListener('click', e => { e.stopPropagation(); fn(e); });
      const up = e => { e.stopPropagation(); el.classList.remove('down'); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', e => e.preventDefault());
    };
    for (const b of this.root.querySelectorAll('.key[data-k]')) press(b, () => b.dataset.k === '⌫' ? controls.onBackspace?.() : controls.onDigit?.(b.dataset.k));
    for (const b of this.root.querySelectorAll('.gadget')) press(b, () => controls.onGadget?.(b.dataset.kind));
    press(document.getElementById('tJump'), () => { controls.jumpQueued = true; });
    press(document.getElementById('tMenu'), () => onMenu(), true);
    press(document.getElementById('tBoard'), () => onBoard(), true);
    this.gadgetEls = Object.fromEntries([...this.root.querySelectorAll('.gadget')].map(e => [e.dataset.kind, e]));

    // Joystick: one pointer, base appears under the thumb.
    const move = document.getElementById('tMove'), stick = document.getElementById('stick'), knob = stick.firstElementChild;
    this.movePointer = null; this.origin = null;
    move.addEventListener('pointerdown', e => {
      if (this.movePointer !== null) return;
      e.preventDefault(); try { move.setPointerCapture(e.pointerId); } catch {}
      this.movePointer = e.pointerId; this.origin = { x: e.clientX, y: e.clientY };
      stick.hidden = false; stick.style.left = `${e.clientX}px`; stick.style.top = `${e.clientY}px`;
      knob.style.transform = 'translate(-50%,-50%)';
    });
    move.addEventListener('pointermove', e => {
      if (e.pointerId !== this.movePointer) return;
      let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) { dx *= STICK_RADIUS / d; dy *= STICK_RADIUS / d; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      controls.touchMove = { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };     // y up = forward
    });
    const endMove = e => {
      if (e.pointerId !== this.movePointer) return;
      this.movePointer = null; stick.hidden = true; controls.touchMove = { x: 0, y: 0 };
    };
    move.addEventListener('pointerup', endMove); move.addEventListener('pointercancel', endMove);

    // Look: one pointer, relative drag.
    const look = document.getElementById('tLook');
    this.lookPointer = null; this.last = null;
    look.addEventListener('pointerdown', e => {
      if (this.lookPointer !== null) return;
      e.preventDefault(); try { look.setPointerCapture(e.pointerId); } catch {}
      this.lookPointer = e.pointerId; this.last = { x: e.clientX, y: e.clientY };
    });
    look.addEventListener('pointermove', e => {
      if (e.pointerId !== this.lookPointer) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y; this.last = { x: e.clientX, y: e.clientY };
      controls.yaw -= dx * LOOK_SENS;
      controls.pitch = Math.max(-1.45, Math.min(1.45, controls.pitch - dy * LOOK_SENS));
      if (controls.yaw > Math.PI) controls.yaw -= Math.PI * 2; if (controls.yaw < -Math.PI) controls.yaw += Math.PI * 2;
    });
    const endLook = e => { if (e.pointerId === this.lookPointer) this.lookPointer = null; };
    look.addEventListener('pointerup', endLook); look.addEventListener('pointercancel', endLook);
    for (const z of [move, look]) z.addEventListener('contextmenu', e => e.preventDefault());
  }

  setGadgets(cds, now) {
    for (const [k, g] of Object.entries(CFG.GADGETS)) {
      const el = this.gadgetEls[k]; const left = Math.max(0, (cds?.[k] || 0) - now);
      el.classList.toggle('ready', left <= 0);
      el.querySelector('.cd').style.height = `${Math.min(100, (left / g.cd) * 100)}%`;
    }
  }
  destroy() { this.root.hidden = true; this.root.innerHTML = ''; this.controls.touchMove = { x: 0, y: 0 }; }
}

// Best effort: phones play in landscape and fullscreen when the browser allows it.
// Must be called synchronously inside a tap handler: Safari refuses fullscreen after any await.
export function goImmersive() {
  const el = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
      p?.catch?.(() => {});
    } catch {}
  }
  try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch {}
}
export function leaveImmersive() {
  try { screen.orientation?.unlock?.(); } catch {}
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  } catch {}
}
