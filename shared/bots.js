// Practice-mode opponents. A bot wanders between waypoints, looks at anyone it can read, and after
// a reaction delay types their code. It plays by the same rules as everyone else: the match only
// accepts its input, type and gadget calls like a real client's.
import { CFG } from './constants.js';
import { stepPlayer, pointInBlockXZ } from './map.js';
import { rng } from './rng.js';

const NAMES = ['Ada', 'Bix', 'Cleo', 'Dash', 'Echo', 'Fizz', 'Gus', 'Hex', 'Iko', 'Juno', 'Kip', 'Lux', 'Moss', 'Nia', 'Oz', 'Pip', 'Quill', 'Rae', 'Sol', 'Tov'];
export function botName(i) { return `${NAMES[i % NAMES.length]} (bot)`; }

export class BotBrain {
  constructor(seed, difficulty = 1) {
    this.r = rng(seed);
    this.difficulty = difficulty;                 // 0.5 gentle .. 2 ruthless
    this.waypoint = null;
    this.target = null;
    this.readFor = 0;
    this.reaction = this.pickReaction();
    this.stuck = 0;
    this.nextGadgetAt = 0;
    this.yawVel = 0;
  }

  pickReaction() { return this.r.range(2.4, 4.8) / this.difficulty; }   // five digits take a moment to read

  think(core, me, dt) {
    if (!me.alive) { this.target = null; this.readFor = 0; return; }
    const map = core.map;
    const now = core.now;

    // Pick someone to read: closest readable enemy, sticky once chosen.
    let target = this.target && core.players.get(this.target.id);
    if (!target || !core.canRead(me, target)) {
      target = null; let best = Infinity;
      for (const q of core.players.values()) {
        if (q === me || !q.alive || !core.canRead(me, q)) continue;
        const d = Math.hypot(q.pos.x - me.pos.x, q.pos.z - me.pos.z);
        if (d < best) { best = d; target = q; }
      }
      if (target !== this.target) { this.readFor = 0; this.reaction = this.pickReaction(); }
      this.target = target;
    }

    // Movement: wander, but slow down while reading.
    if (!this.waypoint || Math.hypot(this.waypoint.x - me.pos.x, this.waypoint.z - me.pos.z) < 1.2 || this.stuck > 1.2) {
      this.waypoint = this.pickWaypoint(map, me);
      this.stuck = 0;
    }
    const wx = this.waypoint.x - me.pos.x, wz = this.waypoint.z - me.pos.z;
    const wd = Math.hypot(wx, wz) || 1;
    const speed = CFG.WALK_SPEED * (target ? 0.45 : 0.85);
    const before = { x: me.pos.x, z: me.pos.z };
    stepPlayer(me.pos, (wx / wd) * speed, (wz / wd) * speed, dt, map, { jump: this.r() < 0.004 });
    const moved = Math.hypot(me.pos.x - before.x, me.pos.z - before.z);
    this.stuck += moved < speed * dt * 0.3 ? dt : -dt * 0.5;
    if (this.stuck < 0) this.stuck = 0;

    // Look: at the target, else where we walk. Smooth turning so the forehead swings believably.
    let wantYaw, wantPitch = 0;
    if (target) {
      const dx = target.pos.x - me.pos.x, dz = target.pos.z - me.pos.z;
      wantYaw = Math.atan2(-dx, -dz);
      wantPitch = Math.atan2((target.pos.y + CFG.FOREHEAD_H) - (me.pos.y + CFG.EYE_H), Math.hypot(dx, dz));
    } else {
      wantYaw = Math.atan2(-wx, -wz);
    }
    me.yaw = turnToward(me.yaw, wantYaw, (target ? 6 : 3) * dt);
    me.pitch += (wantPitch - me.pitch) * Math.min(1, 8 * dt);

    // Read, then type.
    if (target) {
      this.readFor += dt;
      if (this.readFor >= this.reaction && now >= me.lockedUntil) {
        // Occasionally fat-finger a digit, more often on low difficulty.
        let code = target.code;
        if (this.r() < 0.12 / this.difficulty) code = code.slice(0, -1) + ((+code.slice(-1) + 1) % 10);
        core.onType(me.id, code);
        this.readFor = -0.6; this.reaction = this.pickReaction();
      }
    } else this.readFor = Math.max(0, this.readFor - dt * 2);

    // Gadgets: smoke when someone has had eyes on us for a bit, shuffle when we feel watched, flash rarely.
    if (now >= this.nextGadgetAt) {
      const watchers = [...core.players.values()].filter(q => q !== me && q.alive && core.canRead(q, me));
      if (watchers.length) {
        const pick = this.r();
        if (pick < 0.45) core.onGadget(me.id, 'smoke');
        else if (pick < 0.8) core.onGadget(me.id, 'shuffle');
        else core.onGadget(me.id, 'flash');
        this.nextGadgetAt = now + this.r.range(6000, 14000) / this.difficulty;
      } else this.nextGadgetAt = now + 700;
    }
  }

  pickWaypoint(map, me) {
    for (let i = 0; i < 20; i++) {
      const p = { x: this.r.range(-map.half + 2, map.half - 2), z: this.r.range(-map.half + 2, map.half - 2) };
      if (Math.hypot(p.x - me.pos.x, p.z - me.pos.z) < 8) continue;
      if (map.blocks.some(b => pointInBlockXZ(p.x, p.z, b, CFG.PLAYER_R + 0.3))) continue;
      return p;
    }
    return { x: 0, z: 0 };
  }
}

function turnToward(a, b, maxStep) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const s = Math.max(-maxStep, Math.min(maxStep, d));
  let r = a + s;
  if (r > Math.PI) r -= Math.PI * 2; if (r < -Math.PI) r += Math.PI * 2;
  return r;
}
