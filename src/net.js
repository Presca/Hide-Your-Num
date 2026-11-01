// Two transports with one shape: SocketNet talks to the Cloudflare Worker, LocalNet runs the same
// MatchCore in this tab with bots for practice. Both deliver parsed messages to on(fn).
import { CFG, MSG } from '../shared/constants.js';
import { MatchCore } from '../shared/match.js';
import { BotBrain, botName } from '../shared/bots.js';

export class SocketNet {
  constructor(url) {
    this.handlers = [];
    this.onclose = null;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      for (const h of this.handlers) h(m);
    });
    this.ws.addEventListener('close', ev => this.onclose?.(ev.code, ev.reason));
    this.ws.addEventListener('error', () => this.onclose?.(1006, 'connection failed'));
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { this.onclose = null; try { this.ws.close(1000); } catch {} }
}

export class LocalNet {
  constructor(name, { bots = 7, difficulty = 1, roundMs = CFG.ROUND_MS } = {}) {
    this.handlers = [];
    this.onclose = null;
    this.id = 'me';
    this.core = new MatchCore({ now: performance.now(), roundMs, clock: () => performance.now() });
    const seed = (Math.random() * 1e9) | 0;
    for (let i = 0; i < Math.min(bots, CFG.MAX_PLAYERS - 1); i++) {
      this.core.addPlayer(`bot${i}`, botName(i), { bot: true, brain: new BotBrain(seed + i, difficulty * (0.8 + (i % 3) * 0.2)) });
    }
    this.core.addPlayer(this.id, name);
    this.ready = Promise.resolve();
    setTimeout(() => { this.deliver(this.core.welcome(this.id)); }, 0);
    this.timer = setInterval(() => this.tick(), CFG.TICK_MS);
  }
  tick() {
    const out = this.core.tick(performance.now());
    for (const m of out.broadcast) this.deliver(m);
    for (const m of out.perPlayer.get(this.id) || []) this.deliver(m);
  }
  deliver(m) { for (const h of this.handlers) h(m); }
  on(fn) { this.handlers.push(fn); }
  send(m) {
    switch (m.t) {
      case MSG.INPUT: this.core.onInput(this.id, m); break;
      case MSG.TYPE: this.core.onType(this.id, m.code); break;
      case MSG.GADGET: this.core.onGadget(this.id, m.kind); break;
      case MSG.PING: this.deliver({ t: MSG.PONG, ts: m.ts, now: performance.now() }); break;
    }
  }
  close() { clearInterval(this.timer); }
}
