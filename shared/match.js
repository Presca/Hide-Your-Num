// The authoritative match simulation. Runs inside the Cloudflare Durable Object for online play and
// inside the browser for practice mode, so both agree on every rule. It knows nothing about sockets:
// callers feed it inputs and drain the messages it produces each tick.
import { CFG, MSG } from './constants.js';
import { buildMap, stepPlayer, segmentBlocked, segmentHitsSphere, forwardFromYawPitch, pointInBlockXZ } from './map.js';
import { rng } from './rng.js';

const COS_READ = Math.cos((CFG.READ_CONE_DEG * Math.PI) / 180);
const COS_FACE = Math.cos((CFG.FACE_CONE_DEG * Math.PI) / 180);
const COS_FLASH = Math.cos((CFG.GADGETS.flash.coneDeg * Math.PI) / 180);
const COLORS = ['#ff5d5d', '#ffb02e', '#ffe14d', '#7ddc4b', '#3fd1c9', '#4f8cff', '#9b6bff', '#ff6fd8', '#ff8a5b', '#5be0a8'];

export class MatchCore {
  constructor({ now = Date.now(), seed = (Math.random() * 2 ** 31) | 0, roundMs = CFG.ROUND_MS, clock = () => Date.now() } = {}) {
    this.now = now;
    this.clock = clock;              // wall clock for input timing; ticks are too coarse for that
    this.players = new Map();
    this.smokes = [];
    this.outBroadcast = [];
    this.outPrivate = new Map();
    this.roundMs = roundMs;
    this.round = { number: 1, phase: 'play', endsAt: now + roundMs, seed };
    this.map = buildMap(seed);
    this.r = rng(seed ^ 0x9e3779b9);
    this.tickNo = 0;
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  addPlayer(id, name, { bot = false, brain = null } = {}) {
    if (this.players.size >= CFG.MAX_PLAYERS) return null;
    const p = {
      id, name: cleanName(name), bot, brain,
      pos: { x: 0, y: 0, z: 0, vy: 0 }, yaw: 0, pitch: 0,
      alive: false, deadUntil: this.now, code: '',
      lockedUntil: 0, flashedUntil: 0, hiddenUntil: 0,
      cds: { smoke: 0, flash: 0, shuffle: 0 },
      kills: 0, deaths: 0, streak: 0, lastInputAt: this.clock(), moveBudget: 1, seen: new Map(),
      color: COLORS[this.players.size % COLORS.length], dirty: true,
    };
    this.players.set(id, p);
    this.spawn(p);
    this.emit({ t: MSG.EVENT, k: 'join', id, name: p.name });
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.outPrivate.delete(id);
    this.emit({ t: MSG.EVENT, k: 'leave', id, name: p.name });
  }

  welcome(id) {
    const p = this.players.get(id);
    return {
      t: MSG.WELCOME, id, now: this.now, cfg: CFG,
      round: this.roundInfo(),
      players: [...this.players.values()].map(q => this.publicInfo(q)),
      you: p ? this.youInfo(p) : null,
    };
  }

  roundInfo() {
    return { number: this.round.number, phase: this.round.phase, endsAt: this.round.endsAt, seed: this.round.seed, now: this.now, scores: this.scores() };
  }

  scores() {
    return [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, color: p.color, bot: p.bot }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  }

  publicInfo(p) { return { id: p.id, name: p.name, color: p.color, bot: p.bot }; }

  youInfo(p) {
    return {
      t: MSG.YOU, code: p.code, alive: p.alive, deadUntil: p.deadUntil, lockedUntil: p.lockedUntil,
      flashedUntil: p.flashedUntil, cds: p.cds, kills: p.kills, deaths: p.deaths, streak: p.streak, now: this.now,
      pos: p.alive ? [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)] : null,
    };
  }

  // ---- inputs ----------------------------------------------------------------------------------
  onInput(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    if (Number.isFinite(m.yaw)) p.yaw = wrapAngle(m.yaw);
    if (Number.isFinite(m.pitch)) p.pitch = Math.max(-1.5, Math.min(1.5, m.pitch));
    if (!p.alive || !Array.isArray(m.p) || m.p.length !== 3 || !m.p.every(Number.isFinite)) return;
    let [x, y, z] = m.p;
    if (Math.abs(x) > this.map.half || Math.abs(z) > this.map.half || y < -0.5 || y > CFG.WALL_H + 2) return;
    if (this.map.blocks.some(b => !b.wall && y < b.h - 0.1 && pointInBlockXZ(x, z, b, CFG.PLAYER_R * 0.5))) return; // inside a block
    // Speed check as a distance budget measured on the wall clock, so a burst of late packets is
    // fine but nobody can sustain more than walking speed. Over budget: clamp rather than reject,
    // which keeps an honest client with a jittery connection from being snapped back.
    const t = this.clock();
    const dt = Math.max(0, Math.min(0.5, (t - p.lastInputAt) / 1000));
    p.lastInputAt = t;
    p.moveBudget = Math.min(2.5, p.moveBudget + CFG.WALK_SPEED * dt * 1.3);
    const dx = x - p.pos.x, dz = z - p.pos.z, dist = Math.hypot(dx, dz);
    if (dist > p.moveBudget) {
      const k = p.moveBudget / dist;
      x = p.pos.x + dx * k; z = p.pos.z + dz * k;
      p.moveBudget = 0; p.dirty = true;
    } else p.moveBudget -= dist;
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
  }

  onType(id, code) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.round.phase !== 'play') return;
    code = String(code || '').replace(/\D/g, '').slice(0, CFG.CODE_DIGITS);
    if (code.length !== CFG.CODE_DIGITS) return;
    if (this.now < p.lockedUntil) { this.sendTo(id, { t: MSG.EVENT, k: 'miss', code, why: 'locked', until: p.lockedUntil }); return; }
    let wearer = null;
    for (const q of this.players.values()) if (q !== p && q.alive && q.code === code) { wearer = q; break; }
    if (!wearer) {
      p.lockedUntil = this.now + CFG.TYPE_LOCKOUT_MS; p.dirty = true;
      this.sendTo(id, { t: MSG.EVENT, k: 'miss', code, why: 'nocode', until: p.lockedUntil });
      return;
    }
    // Right code: it counts if the wearer is in sight now, or was within the grace window (reading
    // five digits takes a moment and people move).
    const seenAt = p.seen.get(wearer.id) || 0;
    if (!this.canSee(p, wearer) && this.now - seenAt > CFG.TYPE_GRACE_MS) {
      p.lockedUntil = this.now + CFG.TYPE_LOCKOUT_SIGHT_MS; p.dirty = true;
      this.sendTo(id, { t: MSG.EVENT, k: 'miss', code, why: 'sight', until: p.lockedUntil });
      return;
    }
    this.kill(p, wearer, code);
  }

  onGadget(id, kind) {
    const p = this.players.get(id);
    const g = CFG.GADGETS[kind];
    if (!p || !g || !p.alive || this.round.phase !== 'play') return;
    if (this.now < (p.cds[kind] || 0)) return;
    p.cds[kind] = this.now + g.cd; p.dirty = true;
    const eye = { x: p.pos.x, y: p.pos.y + CFG.EYE_H, z: p.pos.z };
    const fwd = forwardFromYawPitch(p.yaw, 0);
    if (kind === 'smoke') {
      // Lob it a few metres ahead, stopping at the first block in the way.
      let d = 0.5, spot = { ...eye, y: 1.0 };
      for (let s = 0.5; s <= 7; s += 0.5) {
        const c = { x: eye.x + fwd.x * s, y: 1.0, z: eye.z + fwd.z * s };
        if (Math.abs(c.x) > this.map.half - 0.5 || Math.abs(c.z) > this.map.half - 0.5) break;
        if (this.map.blocks.some(b => !b.wall && pointInBlockXZ(c.x, c.z, b, 0.3))) break;
        spot = c; d = s;
      }
      const smoke = { id: this.tickNo * 1000 + this.smokes.length, p: [r2(spot.x), 1.0, r2(spot.z)], until: this.now + g.duration, by: id };
      this.smokes.push(smoke);
      this.emit({ t: MSG.EVENT, k: 'smoke', ...smoke, dist: d });
    } else if (kind === 'flash') {
      const victims = [];
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const head = { x: q.pos.x, y: q.pos.y + CFG.EYE_H, z: q.pos.z };
        const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > g.range) continue;
        const f3 = forwardFromYawPitch(p.yaw, p.pitch);
        if ((f3.x * dx + f3.y * dy + f3.z * dz) / dist < COS_FLASH) continue;
        if (segmentBlocked(eye, head, this.map)) continue;
        // Looking away from the flash softens it.
        const qf = forwardFromYawPitch(q.yaw, 0);
        const facing = (qf.x * -dx + qf.z * -dz) / Math.hypot(dx, dz);
        const dur = facing > 0 ? g.duration : g.duration * 0.45;
        q.flashedUntil = Math.max(q.flashedUntil, this.now + dur); q.dirty = true;
        victims.push(q.id);
      }
      this.emit({ t: MSG.EVENT, k: 'flash', by: id, victims, p: [r2(eye.x), r2(eye.y), r2(eye.z)] });
    } else if (kind === 'shuffle') {
      p.code = this.freshCode(); p.hiddenUntil = this.now + g.hidden; p.dirty = true;
      this.emit({ t: MSG.EVENT, k: 'shuffle', id });
    }
  }

  // ---- rules -----------------------------------------------------------------------------------
  // Line of sight from reader's eyes to target's forehead, within range and the crosshair cone,
  // reader not flashed, no smoke in between. Enough to KILL once you know the code.
  canSee(reader, target) {
    if (!reader.alive || !target.alive || reader === target) return false;
    if (this.now < reader.flashedUntil) return false;
    const eye = { x: reader.pos.x, y: reader.pos.y + CFG.EYE_H, z: reader.pos.z };
    const head = { x: target.pos.x, y: target.pos.y + CFG.FOREHEAD_H, z: target.pos.z };
    const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > CFG.READ_RANGE || dist < 1e-3) return false;
    const f = forwardFromYawPitch(reader.yaw, reader.pitch);
    if ((f.x * dx + f.y * dy + f.z * dz) / dist < COS_READ) return false;
    for (const s of this.smokes) {
      if (segmentHitsSphere(eye, head, { x: s.p[0], y: s.p[1], z: s.p[2] }, CFG.GADGETS.smoke.radius)) return false;
    }
    return !segmentBlocked(eye, head, this.map);
  }

  // canSee plus: the target's face is turned towards the reader and they are not mid-shuffle.
  // This is what reveals the digits.
  canRead(reader, target) {
    if (this.now < target.hiddenUntil) return false;
    if (!this.canSee(reader, target)) return false;
    return this.facing(target, reader);
  }
  facing(target, reader) {
    const tf = forwardFromYawPitch(target.yaw, 0);
    const dx = reader.pos.x - target.pos.x, dz = reader.pos.z - target.pos.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    return (tf.x * dx + tf.z * dz) / d >= COS_FACE;
  }

  kill(killer, victim, code) {
    victim.alive = false; victim.deaths++; victim.streak = 0; victim.deadUntil = this.now + CFG.RESPAWN_MS; victim.dirty = true;
    killer.kills++; killer.streak++; killer.dirty = true;
    this.emit({ t: MSG.EVENT, k: 'kill', by: killer.id, victim: victim.id, code, streak: killer.streak, p: [r2(victim.pos.x), r2(victim.pos.y), r2(victim.pos.z)] });
  }

  spawn(p) {
    const others = [...this.players.values()].filter(q => q !== p && q.alive);
    let best = null, bestScore = -1;
    const cands = this.map.spawns.length ? this.map.spawns : [{ x: 0, z: 10 }];
    for (let i = 0; i < 10; i++) {
      const s = this.r.pick(cands);
      let score = Infinity;
      for (const q of others) score = Math.min(score, Math.hypot(q.pos.x - s.x, q.pos.z - s.z));
      if (score > bestScore) { bestScore = score; best = s; }
    }
    p.pos = { x: best.x, y: 0, z: best.z, vy: 0 };
    p.yaw = wrapAngle(Math.atan2(best.x, best.z)); // face the centre
    p.pitch = 0;
    p.alive = true; p.code = this.freshCode(); p.hiddenUntil = 0; p.flashedUntil = 0; p.lockedUntil = 0;
    p.lastInputAt = this.clock(); p.moveBudget = 1; p.dirty = true;
    this.emit({ t: MSG.EVENT, k: 'spawn', id: p.id, p: [r2(p.pos.x), 0, r2(p.pos.z)], yaw: r2(p.yaw) });
  }

  freshCode() {
    const lo = 10 ** (CFG.CODE_DIGITS - 1), hi = 10 ** CFG.CODE_DIGITS - 1;
    const used = new Set([...this.players.values()].map(p => p.code));
    for (let i = 0; i < 500; i++) {
      const c = String(this.r.int(lo, hi));
      if (!used.has(c) && !/^(\d)\1+$/.test(c)) return c;      // no 111/222: too easy to guess
    }
    return String(this.r.int(lo, hi));
  }

  // ---- tick ------------------------------------------------------------------------------------
  tick(now) {
    const dt = Math.min(0.25, (now - this.now) / 1000);
    this.now = now; this.tickNo++;

    // Round clock.
    if (this.round.phase === 'play' && now >= this.round.endsAt) {
      this.round.phase = 'end'; this.round.endsAt = now + CFG.INTERMISSION_MS;
      this.emit({ t: MSG.ROUND, ...this.roundInfo() });
    } else if (this.round.phase === 'end' && now >= this.round.endsAt) {
      this.startRound();
    }

    this.smokes = this.smokes.filter(s => s.until > now);

    for (const p of this.players.values()) {
      if (p.brain) p.brain.think(this, p, dt);
      if (!p.alive && now >= p.deadUntil && this.round.phase === 'play') this.spawn(p);
    }

    // Snapshots: each viewer only receives the codes they can currently read (so the wire carries
    // nothing a cheat could use to read through walls).
    const out = { broadcast: this.outBroadcast, perPlayer: new Map() };
    const base = [...this.players.values()].map(q => ({
      id: q.id, p: [r2(q.pos.x), r2(q.pos.y), r2(q.pos.z)], yaw: r2(q.yaw), pitch: r2(q.pitch), a: q.alive ? 1 : 0,
      h: now < q.hiddenUntil ? 1 : 0, f: now < q.flashedUntil ? 1 : 0, s: q.streak,
    }));
    const smokes = this.smokes.map(s => ({ id: s.id, p: s.p, until: s.until }));
    for (const viewer of this.players.values()) {
      if (viewer.bot) continue;
      const msgs = this.outPrivate.get(viewer.id) || [];
      this.outPrivate.delete(viewer.id);
      const players = base.map(b => {
        const q = this.players.get(b.id);
        if (q === viewer) return { ...b, n: q.code };
        const see = this.canSee(viewer, q);
        if (see) viewer.seen.set(q.id, now);
        const readable = see && now >= q.hiddenUntil && this.facing(q, viewer);
        return readable ? { ...b, n: q.code } : b;
      });
      msgs.push({ t: MSG.STATE, tick: this.tickNo, now, players, smokes, round: this.round.phase, endsAt: this.round.endsAt });
      if (viewer.dirty) { msgs.push(this.youInfo(viewer)); viewer.dirty = false; }
      out.perPlayer.set(viewer.id, msgs);
    }
    this.outBroadcast = [];
    this.outPrivate = new Map();
    return out;
  }

  startRound() {
    const seed = (this.r() * 2 ** 31) | 0;
    this.round = { number: this.round.number + 1, phase: 'play', endsAt: this.now + this.roundMs, seed };
    this.map = buildMap(seed);
    this.smokes = [];
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.streak = 0; p.cds = { smoke: 0, flash: 0, shuffle: 0 };
      this.spawn(p);
    }
    this.emit({ t: MSG.ROUND, ...this.roundInfo() });
  }

  emit(msg) { this.outBroadcast.push(msg); }
  sendTo(id, msg) {
    if (!this.outPrivate.has(id)) this.outPrivate.set(id, []);
    this.outPrivate.get(id).push(msg);
  }
}

export function cleanName(name) {
  const s = String(name ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14);
  return s || 'Player';
}
function wrapAngle(a) { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }
function r2(v) { return Math.round(v * 100) / 100; }
