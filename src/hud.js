// DOM overlay: typed digits, own number, timer, feed, gadgets, death and scoreboard. Plus tiny
// synthesised sounds so a read, a miss and a kill each have a distinct beep.
import { CFG } from '../shared/constants.js';

const $ = id => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), typed: $('typed'), mynum: $('mynum'), timer: $('timer'), feed: $('feed'), gadgets: $('gadgets'),
      kills: $('kills'), deaths: $('deaths'), center: $('centerMsg'), dead: $('deadOverlay'), deadBy: $('deadBy'), respawnIn: $('respawnIn'),
      board: $('scoreboard'), boardTitle: $('boardTitle'), boardBody: $('boardBody'), boardFoot: $('boardFoot'),
      paused: $('pausedOverlay'), flash: $('flashFx'), smoke: $('smokeFx'), hit: $('hitFx'), room: $('roomPill'), ping: $('pingPill'),
      mynumBox: document.querySelector('.mynum'),
    };
    this.slots = [...this.el.typed.querySelectorAll('.slot')];
    this.el.gadgets.innerHTML = Object.entries(CFG.GADGETS).map(([k, g]) =>
      `<div class="gadget ready" data-kind="${k}"><div class="cd"></div><kbd>${g.key}</kbd><span>${g.label}</span></div>`).join('');
    this.gadgetEls = Object.fromEntries([...this.el.gadgets.children].map(e => [e.dataset.kind, e]));
    this.centerTimer = 0;
    this.audio = null;
  }

  show(on) { this.el.hud.hidden = !on; }
  setRoom(text) { this.el.room.textContent = text; }
  setPing(ms) { this.el.ping.textContent = ms == null ? '—' : `${Math.round(ms)} ms`; }
  setScore(k, d) { this.el.kills.textContent = k; this.el.deaths.textContent = d; }

  setTyped(buf, state) {
    this.slots.forEach((s, i) => { s.textContent = buf[i] || ''; s.classList.toggle('on', !!buf[i]); });
    this.el.typed.classList.toggle('locked', state === 'locked');
    this.el.typed.classList.toggle('ok', state === 'ok');
  }
  setMyNum(code, hidden) {
    this.el.mynum.textContent = code || '···';
    this.el.mynumBox.classList.toggle('hidden', !!hidden);
  }
  setTimer(msLeft, phase) {
    const s = Math.max(0, Math.ceil(msLeft / 1000));
    this.el.timer.textContent = phase === 'end' ? 'Next round' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.el.timer.classList.toggle('low', phase === 'play' && s <= 30);
  }
  setGadgets(cds, now) {
    for (const [k, g] of Object.entries(CFG.GADGETS)) {
      const el = this.gadgetEls[k]; const left = Math.max(0, (cds?.[k] || 0) - now);
      el.classList.toggle('ready', left <= 0);
      el.querySelector('.cd').style.height = `${Math.min(100, (left / g.cd) * 100)}%`;
    }
  }
  feed(html, mine = false) {
    const d = document.createElement('div'); d.innerHTML = html; if (mine) d.classList.add('me');
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 6) this.el.feed.lastChild.remove();
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .5s'; setTimeout(() => d.remove(), 500); }, 6000);
  }
  center(text, ms = 1800) {
    this.el.center.textContent = text; this.el.center.classList.add('on');
    clearTimeout(this.centerTimer); this.centerTimer = setTimeout(() => this.el.center.classList.remove('on'), ms);
  }
  hit() { const h = this.el.hit; h.classList.remove('on'); void h.offsetWidth; h.classList.add('on'); }
  flash(amount) { this.el.flash.style.opacity = String(Math.max(0, Math.min(1, amount))); }
  smoke(on) { this.el.smoke.style.opacity = on ? '1' : '0'; }
  dead(byName) { this.el.dead.hidden = false; this.el.deadBy.textContent = byName ? `${byName} read your number` : ''; }
  respawnCountdown(ms) { this.el.respawnIn.textContent = Math.max(0, Math.ceil(ms / 1000)); }
  alive() { this.el.dead.hidden = true; }
  paused(on) { this.el.paused.hidden = !on; }

  scoreboard(show, scores, selfId, title, foot) {
    this.el.board.hidden = !show; if (!show) return;
    this.el.boardTitle.textContent = title || 'Scoreboard';
    this.el.boardFoot.textContent = foot || '';
    this.el.boardBody.innerHTML = scores.map((s, i) =>
      `<tr class="${s.id === selfId ? 'me' : ''}"><td class="n">${i + 1}</td><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};margin-right:8px"></span>${esc(s.name)}</td><td class="n">${s.kills}</td><td class="n">${s.deaths}</td></tr>`).join('');
  }

  // --- sfx -------------------------------------------------------------------------------------
  beep(kind) {
    try {
      if (!this.audio) this.audio = new (window.AudioContext || window.webkitAudioContext)();
      const a = this.audio; if (a.state === 'suspended') a.resume();
      const t = a.currentTime;
      const tone = (f0, f1, dur, type = 'square', vol = 0.05, at = 0) => {
        const o = a.createOscillator(), g = a.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
        g.gain.setValueAtTime(vol, t + at); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        o.connect(g).connect(a.destination); o.start(t + at); o.stop(t + at + dur + 0.02);
      };
      if (kind === 'key') tone(900, 700, 0.05, 'square', 0.03);
      else if (kind === 'miss') tone(220, 110, 0.25, 'sawtooth', 0.05);
      else if (kind === 'kill') { tone(600, 1200, 0.12, 'square', 0.05); tone(900, 1800, 0.18, 'square', 0.04, 0.1); }
      else if (kind === 'die') { tone(400, 60, 0.6, 'sawtooth', 0.06); }
      else if (kind === 'gadget') tone(300, 500, 0.1, 'triangle', 0.05);
      else if (kind === 'flash') tone(2000, 3000, 0.5, 'sine', 0.05);
      else if (kind === 'round') { tone(500, 500, 0.12, 'triangle', 0.05); tone(750, 750, 0.2, 'triangle', 0.05, 0.14); }
    } catch {}
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
