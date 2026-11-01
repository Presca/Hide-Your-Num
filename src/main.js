// Entry point: menu, match loop, message handling. Nothing here decides who gets eliminated; the
// match simulation (locally for practice, on the Worker online) is the referee.
import { CFG, MSG } from '../shared/constants.js';
import { buildMap } from '../shared/map.js';
import { World } from './world.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { SocketNet, LocalNet } from './net.js';
import { TouchUI, isTouchDevice, goImmersive, leaveImmersive } from './touch.js';

const BUILD = 9;   // bump when the client changes; shown in the menu so stale caches are obvious
const $ = id => document.getElementById(id);
const cfg = window.HYN_CONFIG || {};
const canvas = $('gl');
const hud = new Hud();
let world = null;
const controls = new Controls(canvas);

const menu = $('menu'), nameInput = $('name'), roomInput = $('roomCode'), note = $('menuNote');
// Storage can throw in private windows or with strict privacy settings; the game must not care.
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
nameInput.value = store.get('hyn.name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) roomInput.value = urlRoom.toUpperCase();
$('build').textContent = `build ${BUILD}`;
const keyLookBox = $('keyLook');
keyLookBox.checked = store.get('hyn.keylook') !== '0';
controls.keyLook = keyLookBox.checked;
keyLookBox.addEventListener('change', () => { controls.keyLook = keyLookBox.checked; store.set('hyn.keylook', keyLookBox.checked ? '1' : '0'); });
if (!cfg.workerUrl) {
  $('btnQuick').disabled = true; $('btnJoin').disabled = true;
  note.textContent = 'Online play is not configured on this site yet (see config.js). Practice works.';
}
const TOUCH = isTouchDevice();
if (TOUCH) document.documentElement.classList.add('is-touch');
// Check the match server on load so a blocked or down server is visible before anyone clicks.
if (cfg.workerUrl) {
  const host = cfg.workerUrl.replace(/^https?:\/\//, '');
  fetch(`${cfg.workerUrl}/health`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(() => { if (!note.textContent) setNote(`Server online: ${host}`); })
    .catch(e => setNote(`Can't reach the match server at ${host} (${e.message}). An ad blocker, VPN or network filter may be blocking workers.dev. Practice still works.`, true));
}
window.addEventListener('error', e => { if (!menu.hidden) setNote(`Error: ${e.message}`, true); });
window.addEventListener('unhandledrejection', e => { if (!menu.hidden) setNote(`Error: ${e.reason?.message || e.reason}`, true); });

$('btnQuick').onclick = async () => {
  try {
    setNote('Finding a room…');
    const res = await fetch(`${cfg.workerUrl}/quick`);
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { code } = await res.json();
    joinOnline(code);
  } catch (e) { setNote(`Could not reach the server: ${e.message}`, true); }
};
$('btnJoin').onclick = () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) return setNote('Room codes are 4 letters, like KQ7X.', true);
  joinOnline(code);
};
$('btnPractice').onclick = () => start(new LocalNet(playerName(), { bots: 7, roundMs: Number(new URLSearchParams(location.search).get('round')) * 1000 || undefined }), 'PRACTICE');
$('btnLeave').onclick = () => leave();
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });

function playerName() {
  const n = nameInput.value.trim().slice(0, 14) || 'Player';
  store.set('hyn.name', n);
  return n;
}
function setNote(t, err = false) { note.textContent = t; note.classList.toggle('err', err); }
function joinOnline(code) {
  const base = cfg.workerUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  setNote(`Joining ${code}…`);
  let net;
  try { net = new SocketNet(`${base}/room/${code}/ws?name=${encodeURIComponent(playerName())}`); }
  catch (e) { return setNote(`Could not open a connection: ${e.message}`, true); }
  net.onclose = (c, reason) => setNote(c === 4001 ? 'That room is full.' : `Could not connect to room ${code} (${c}${reason ? `, ${reason}` : ''}). Check the code, or try Quick play.`, true);
  net.ready.then(() => { start(net, code); try { history.replaceState(null, '', `?room=${code}`); } catch {} })
    .catch(() => {});
}

// ------------------------------------------------------------------------------------------------
let G = null;   // current match state

function start(net, roomLabel) {
  if (!world) world = new World(canvas, { lowPower: TOUCH });
  G = {
    net, room: roomLabel, id: null, map: null, seed: null, players: new Map(), self: null,
    offset: 0, rtt: null, lastSend: 0, lastPing: 0, buf: '', typedState: '', typedTimer: 0,
    round: { phase: 'play', endsAt: 0, number: 1 }, lastSnap: null, deadBy: '', wasAlive: false, boardHeld: false, raf: 0, last: performance.now(),
  };
  net.on(onMessage);
  net.onclose = (code, reason) => { leave(code === 4001 ? 'That room is full.' : `Disconnected${reason ? `: ${reason}` : ''}.`); };
  document.documentElement.classList.add('ingame');
  menu.hidden = true; hud.show(true); hud.setRoom(roomLabel); hud.paused(false); hud.alive(); hud.scoreboard(false);
  hud.setTyped('', ''); hud.setMyNum('');
  controls.enabled = false;
  if (TOUCH) {
    G.touch = new TouchUI(controls, { onMenu: () => hud.paused(true), onBoard: () => toggleBoard() });
    goImmersive();
  } else controls.requestLock();
  if (controls.noLock) window.__hyn = { G, controls, world, hud };   // automated tests only
  G.raf = requestAnimationFrame(frame);
}

function leave(message) {
  if (!G) return;
  cancelAnimationFrame(G.raf);
  G.touch?.destroy();
  if (TOUCH) leaveImmersive();
  G.net.close();
  for (const id of [...world.players.keys()]) world.removePlayer(id);
  world.setSmokes([]);
  G = null;
  controls.releaseLock();
  hud.show(false); hud.flash(0); hud.smoke(false);
  document.documentElement.classList.remove('ingame');
  menu.hidden = false;
  if (message) setNote(message, true); else setNote('');
}

controls.onLockChange = locked => { if (G) hud.paused(!locked); };
canvas.addEventListener('click', () => { if (G && !TOUCH) controls.requestLock(); });
$('pausedOverlay').addEventListener('click', e => { if (e.target.tagName === 'BUTTON' || !G) return; if (TOUCH) hud.paused(false); else controls.requestLock(); });
$('scoreboard').addEventListener('click', () => { if (TOUCH && G?.boardHeld) toggleBoard(); });
function toggleBoard() {
  if (!G || G.round.phase !== 'play') return;
  G.boardHeld = !G.boardHeld;
  hud.scoreboard(G.boardHeld, G.lastScores || [], G.id, 'Scoreboard', `Round ${G.round.number} · ${G.players.size} players`);
}

controls.onDigit = d => {
  if (!G || !G.self) return;
  const now = serverNow();
  if (!G.self.alive || G.round.phase !== 'play' || now < G.self.lockedUntil) { hud.setTyped(G.buf, 'locked'); hud.beep('miss'); return; }
  G.buf += d; hud.beep('key');
  hud.setTyped(G.buf, '');
  if (G.buf.length >= CFG.CODE_DIGITS) {
    G.net.send({ t: MSG.TYPE, code: G.buf });
    G.buf = '';
    clearTimeout(G.typedTimer);
    G.typedTimer = setTimeout(() => G && hud.setTyped(G.buf, ''), 350);
  }
};
controls.onBackspace = () => { if (G) { G.buf = ''; hud.setTyped('', ''); } };
controls.onGadget = kind => {
  if (!G || !G.self?.alive) return;
  if (serverNow() < (G.self.cds?.[kind] || 0)) return;
  G.net.send({ t: MSG.GADGET, kind }); hud.beep('gadget');
};
controls.onTab = down => { if (G) { G.boardHeld = down; if (G.round.phase === 'play') hud.scoreboard(down, G.lastScores || [], G.id, 'Scoreboard', `Round ${G.round.number} · ${G.players.size} players`); } };

function serverNow() { return Date.now() + (G?.offset || 0); }

function onMessage(m) {
  if (!G) return;
  switch (m.t) {
    case MSG.WELCOME: {
      G.id = m.id; G.offset = m.now - Date.now();
      for (const p of m.players) addPlayer(p);
      applyRound(m.round, true);
      if (m.you) applyYou(m.you, true);
      break;
    }
    case MSG.STATE: {
      // Gentle clock sync: trust the server's "now" plus half the round trip.
      const est = m.now + (G.rtt || 0) / 2 - Date.now();
      G.offset += (est - G.offset) * 0.1;
      G.lastSnap = m;
      world.applyState(m.players, G.id);
      world.setSmokes(m.smokes);
      if (m.round !== G.round.phase) { G.round.phase = m.round; G.round.endsAt = m.endsAt; }
      const me = m.players.find(p => p.id === G.id);
      if (me && G.self?.alive) {
        // Snap back only if we have drifted far from where the server has us (clamped speed, a
        // wall it refused, or packet loss). Normal latency keeps this well under the threshold.
        const d = Math.hypot(me.p[0] - controls.pos.x, me.p[2] - controls.pos.z);
        if (d > 3) controls.teleport(me.p);
        if (G.self.code !== me.n && me.n) { G.self.code = me.n; hud.setMyNum(me.n, !!me.h); }
        hud.setMyNum(G.self.code, !!me.h);
      }
      break;
    }
    case MSG.YOU: applyYou(m); break;
    case MSG.ROUND: applyRound(m); break;
    case MSG.PONG: G.rtt = Date.now() - m.ts; hud.setPing(G.rtt); break;
    case MSG.ERROR: leave(m.code === 'full' ? 'That room is full.' : `Server error: ${m.code}`); break;
    case MSG.EVENT: onEvent(m); break;
  }
}

function addPlayer(p) { G.players.set(p.id, p); if (p.id !== G.id) world.addPlayer(p.id, p); }

function applyYou(y, first = false) {
  const was = G.self?.alive;
  G.self = { ...G.self, ...y };
  hud.setScore(y.kills, y.deaths);
  if (y.code) hud.setMyNum(y.code, false);
  if (y.alive && (!was || first)) {
    if (y.pos) controls.teleport(y.pos, G.spawnYaw, true);
    hud.alive(); G.buf = ''; hud.setTyped('', '');
  }
  controls.enabled = !!y.alive && G.round.phase === 'play';
}

function applyRound(r, first = false) {
  G.round = { phase: r.phase, endsAt: r.endsAt, number: r.number };
  G.lastScores = r.scores;
  if (r.seed !== G.seed) { G.seed = r.seed; G.map = buildMap(r.seed); world.setMap(G.map); }
  if (r.phase === 'end') {
    const top = r.scores[0];
    hud.scoreboard(true, r.scores, G.id, `Round ${r.number} over`, top ? `${top.id === G.id ? 'You' : top.name} ${top.id === G.id ? 'win' : 'wins'} with ${top.kills} elimination${top.kills === 1 ? '' : 's'}` : '');
    hud.beep('round'); controls.enabled = false;
  } else {
    hud.scoreboard(false);
    controls.enabled = !!G.self?.alive;
    if (!first) { hud.center(`Round ${r.number}`); hud.beep('round'); }
  }
}

function onEvent(e) {
  const name = id => id === G.id ? 'You' : (G.players.get(id)?.name || '?');
  switch (e.k) {
    case 'join': addPlayer({ id: e.id, name: e.name, color: colorFor(e.id) }); if (e.id !== G.id) hud.feed(`${esc(e.name)} joined`); break;
    case 'leave': G.players.delete(e.id); world.removePlayer(e.id); hud.feed(`${esc(e.name)} left`); break;
    case 'spawn':
      if (e.id === G.id) { G.spawnYaw = e.yaw; controls.teleport(e.p, e.yaw, true); controls.enabled = G.round.phase === 'play'; hud.alive(); }
      break;
    case 'kill': {
      const mine = e.by === G.id, me = e.victim === G.id;
      hud.feed(`<b>${esc(name(e.by))}</b> read <b>${esc(name(e.victim))}</b><span class="code">${e.code}</span>`, mine || me);
      world.burst(e.p, G.players.get(e.victim)?.color);
      if (mine) { hud.hit(); hud.setTyped(e.code, 'ok'); hud.beep('kill'); if (e.streak >= 3) hud.center(`${e.streak} in a row!`); }
      if (me) { G.deadBy = name(e.by); hud.dead(G.deadBy); hud.beep('die'); controls.enabled = false; }
      break;
    }
    case 'miss': hud.setTyped(e.code, 'locked'); hud.beep('miss'); setTimeout(() => G && hud.setTyped(G.buf, ''), CFG.TYPE_LOCKOUT_MS); break;
    case 'flash': if (e.victims.includes(G.id)) { hud.beep('flash'); } break;
    case 'shuffle': if (e.id === G.id) hud.center('New number', 900); break;
  }
}

function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 80% 65%)`; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------------------------------------------
function frame(t) {
  if (!G) return;
  G.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - G.last) / 1000); G.last = t;
  const now = serverNow();

  controls.update(dt, G.map);
  if (t - G.lastSend >= CFG.INPUT_MS) {
    G.lastSend = t;
    G.net.send({ t: MSG.INPUT, p: [controls.pos.x, controls.pos.y, controls.pos.z], yaw: controls.yaw, pitch: controls.pitch });
  }
  if (t - G.lastPing >= CFG.PING_MS) { G.lastPing = t; G.net.send({ t: MSG.PING, ts: Date.now() }); }

  const eye = { x: controls.pos.x, y: controls.pos.y + CFG.EYE_H, z: controls.pos.z };
  world.update(dt, eye, controls.yaw, controls.pitch);

  hud.setTimer(G.round.endsAt - now, G.round.phase);
  if (G.self) {
    hud.setGadgets(G.self.cds, now);
    G.touch?.setGadgets(G.self.cds, now);
    if (!G.self.alive) hud.respawnCountdown(G.self.deadUntil - now);
    const flashLeft = (G.self.flashedUntil || 0) - now;
    hud.flash(flashLeft > 0 ? Math.min(1, flashLeft / 900) : 0);
  }
  hud.smoke(world.cameraInSmoke());
}
