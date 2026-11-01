// Exercises a deployed match server end to end: health, quick play, two sockets in one room, a
// read and an elimination. Run with:  node tools/live-check.mjs https://hide-your-num.<you>.workers.dev
// Needs the `ws` package (npm i ws) because Node's built-in WebSocket cannot send an Origin header.
import WebSocket from 'ws';
import { buildMap, stepPlayer } from '../shared/map.js';

const base = (process.argv[2] || '').replace(/\/$/, '');
const origin = process.argv[3] || 'https://presca.github.io';
if (!base) { console.error('usage: node tools/live-check.mjs <worker url> [origin]'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async path => {
  const r = await fetch(base + path, { headers: { Origin: origin } });
  const text = await r.text();
  log(`GET ${path} -> ${r.status} ${text.slice(0, 200)}`);
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return JSON.parse(text);
};
const open = (code, name) => new Promise((res, rej) => {
  const url = `${base.replace(/^http/, 'ws')}/room/${code}/ws?name=${name}`;
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  const c = { ws, welcome: null, state: null, you: null, events: [], closed: null };
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'welcome') c.welcome = m; if (m.t === 'state') c.state = m; if (m.t === 'you') c.you = { ...c.you, ...m }; if (m.t === 'ev') c.events.push(m); if (m.t === 'error') c.error = m; });
  ws.on('open', () => { log(`${name}: socket open`); res(c); });
  ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; log(`${name}: closed ${code} ${reason}`); });
  ws.on('error', e => { log(`${name}: error ${e.message}`); rej(e); });
  ws.on('unexpected-response', (req, r) => { let b = ''; r.on('data', d => b += d); r.on('end', () => { log(`${name}: upgrade refused HTTP ${r.statusCode} ${b.slice(0, 200)}`); rej(new Error(`HTTP ${r.statusCode}`)); }); });
});

await get('/health');
const { code } = await get('/quick');
await get(`/room/${code}/info`);
const A = await open(code, 'CheckA');
await sleep(500);
if (!A.welcome) throw new Error('no welcome for A');
log('A welcomed, players in room:', A.welcome.players.map(p => p.name).join(', '));
const B = await open(code, 'CheckB');
await sleep(500);
if (!B.welcome) throw new Error('no welcome for B');
await get(`/room/${code}/info`);

// A walks up to B and reads their number.
const map = buildMap(A.welcome.round.seed);
const me = () => A.state.players.find(p => p.id === A.welcome.id);
const bob = () => A.state.players.find(p => p.id === B.welcome.id);
const face = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
const pos = { x: me().p[0], y: 0, z: me().p[2], vy: 0 };
let read = null, stuck = 0, side = 1, sideFor = 0;
for (let i = 0; i < 600 && !read; i++) {
  const b = bob().p;
  B.ws.send(JSON.stringify({ t: 'in', p: b, yaw: face(b, [pos.x, 0, pos.z]), pitch: 0 }));
  const dx = b[0] - pos.x, dz = b[2] - pos.z, d = Math.hypot(dx, dz);
  let vx = 0, vz = 0;
  if (d > 2.5) { vx = dx / d * 5; vz = dz / d * 5; if (sideFor > 0) { vx += -dz / d * 5 * side; vz += dx / d * 5 * side; sideFor--; } }
  const before = { ...pos };
  stepPlayer(pos, vx, vz, 0.05, map, {});
  if (d > 2.5 && Math.hypot(pos.x - before.x, pos.z - before.z) < 0.05) { if (++stuck > 3) { side = -side; sideFor = 40; stuck = 0; } } else stuck = 0;
  A.ws.send(JSON.stringify({ t: 'in', p: [pos.x, pos.y, pos.z], yaw: face([pos.x, 0, pos.z], b), pitch: 0 }));
  await sleep(50);
  if (bob()?.n) { read = bob().n; A.ws.send(JSON.stringify({ t: 'type', code: read })); }
}
await sleep(500);
const kill = A.events.find(e => e.k === 'kill');
log('read code:', read, 'kill event:', !!kill, 'B dead:', B.you?.alive === false, 'A ping/pong ok:', !!A.state);
A.ws.close(); B.ws.close();
await sleep(500);
await get(`/room/${code}/info`);
if (!read || !kill) { log('LIVE CHECK FAILED'); process.exit(1); }
log('LIVE CHECK OK');
