// Hide Your Num match server for Cloudflare Workers.
//
//   GET  /quick                 -> { code }   a room with space (quick play)
//   GET  /room/:CODE/info       -> { code, players, max, phase }
//   GET  /room/:CODE/ws?name=.. -> WebSocket into that room
//
// Each room is a Durable Object running one MatchCore (see shared/match.js) at 20 Hz and holding up
// to CFG.MAX_PLAYERS sockets. The Lobby object only remembers how full each room is.
import { MatchCore, cleanName } from '../../shared/match.js';
import { CFG, MSG } from '../../shared/constants.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MSG_BYTES = 2048;
const MAX_MSGS_PER_SEC = 60;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : allowed[0] || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, max: CFG.MAX_PLAYERS });
    if (!originOk) return json({ code: 'origin' }, 403);

    if (url.pathname === '/quick') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      const res = await lobby.fetch('https://lobby/quick');
      return json(await res.json());
    }

    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,6})\/(info|ws)$/i);
    if (!m) return json({ code: 'not_found' }, 404);
    const code = m[1].toUpperCase();
    const room = env.MATCH.get(env.MATCH.idFromName(code));
    if (m[2] === 'info') {
      const res = await room.fetch(`https://room/info?code=${code}`);
      return json(await res.json());
    }
    if (req.headers.get('Upgrade') !== 'websocket') return json({ code: 'upgrade_required' }, 426);
    const target = new URL(`https://room/ws?code=${code}&name=${encodeURIComponent(url.searchParams.get('name') || '')}`);
    return room.fetch(new Request(target, req));
  },
};

export class Match {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.core = null;
    this.sockets = new Map();        // ws -> { id, name, count, windowStart }
    this.timer = null;
    this.code = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    this.code = url.searchParams.get('code') || this.code;
    if (url.pathname === '/info') {
      return Response.json({ code: this.code, players: this.sockets.size, max: CFG.MAX_PLAYERS, phase: this.core?.round.phase || 'idle' });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (this.sockets.size >= CFG.MAX_PLAYERS) {
      server.send(JSON.stringify({ t: MSG.ERROR, code: 'full' }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.core) this.core = new MatchCore({ now: Date.now() });
    const id = randomId();
    const name = cleanName(url.searchParams.get('name'));
    this.sockets.set(server, { id, name, count: 0, windowStart: Date.now() });
    this.core.addPlayer(id, name);
    server.send(JSON.stringify(this.core.welcome(id)));

    server.addEventListener('message', ev => this.onMessage(server, ev));
    const bye = () => this.drop(server);
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    if (!this.timer) this.timer = setInterval(() => this.tick(), CFG.TICK_MS);
    this.report();
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, ev) {
    const meta = this.sockets.get(ws);
    if (!meta || typeof ev.data !== 'string' || ev.data.length > MAX_MSG_BYTES) return;
    const now = Date.now();
    if (now - meta.windowStart > 1000) { meta.windowStart = now; meta.count = 0; }
    if (++meta.count > MAX_MSGS_PER_SEC) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case MSG.INPUT: this.core.onInput(meta.id, m); break;
      case MSG.TYPE: this.core.onType(meta.id, m.code); break;
      case MSG.GADGET: this.core.onGadget(meta.id, String(m.kind || '')); break;
      case MSG.PING: safeSend(ws, JSON.stringify({ t: MSG.PONG, ts: m.ts, now })); break;
    }
  }

  drop(ws) {
    const meta = this.sockets.get(ws);
    if (!meta) return;
    this.sockets.delete(ws);
    this.core.removePlayer(meta.id);
    try { ws.close(1000); } catch {}
    if (this.sockets.size === 0) {
      clearInterval(this.timer); this.timer = null;
      this.core = null;                       // a fresh round next time someone joins
    }
    this.report();
  }

  tick() {
    if (!this.core) return;
    const out = this.core.tick(Date.now());
    const broadcast = out.broadcast.length ? out.broadcast.map(m => JSON.stringify(m)) : null;
    for (const [ws, meta] of this.sockets) {
      if (broadcast) for (const s of broadcast) safeSend(ws, s);
      const mine = out.perPlayer.get(meta.id);
      if (mine) for (const m of mine) safeSend(ws, JSON.stringify(m));
    }
  }

  report() {
    if (!this.code) return;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
    lobby.fetch('https://lobby/report', { method: 'POST', body: JSON.stringify({ code: this.code, players: this.sockets.size }) }).catch(() => {});
  }
}

export class Lobby {
  constructor(state) {
    this.state = state;
    this.rooms = null;               // code -> { players, at }
  }
  async load() {
    if (!this.rooms) this.rooms = (await this.state.storage.get('rooms')) || {};
  }
  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const now = Date.now();
    if (url.pathname === '/report') {
      const { code, players } = await req.json();
      if (players > 0) this.rooms[code] = { players, at: now }; else delete this.rooms[code];
      await this.state.storage.put('rooms', this.rooms);
      return Response.json({ ok: true });
    }
    // Quick play: fullest room that still has space and was heard from in the last 2 minutes.
    let best = null;
    for (const [code, r] of Object.entries(this.rooms)) {
      if (now - r.at > 120_000) { delete this.rooms[code]; continue; }
      if (r.players < CFG.MAX_PLAYERS && (!best || r.players > this.rooms[best].players)) best = code;
    }
    if (!best) {
      do { best = ''; for (let i = 0; i < 4; i++) best += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (this.rooms[best]);
      this.rooms[best] = { players: 0, at: now };
    }
    await this.state.storage.put('rooms', this.rooms);
    return Response.json({ code: best });
  }
}

function randomId() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeSend(ws, s) { try { ws.send(s); } catch {} }
