// Arena generation and geometry queries. Deterministic from a seed so every client draws the exact
// same cover the server uses for line-of-sight checks.
import { CFG } from './constants.js';
import { rng } from './rng.js';

// A block is an axis-aligned box standing on the floor: centre (x,z), half extents (hw,hd), height h.
export function buildMap(seed) {
  const r = rng(seed);
  const half = CFG.ARENA / 2;
  const blocks = [];
  const palette = r.int(0, 5);

  // Border walls (thick, tall) so nobody leaves the arena.
  const t = 1;
  blocks.push({ x: 0, z: -half - t, hw: half + 2 * t, hd: t, h: CFG.WALL_H, wall: true });
  blocks.push({ x: 0, z: half + t, hw: half + 2 * t, hd: t, h: CFG.WALL_H, wall: true });
  blocks.push({ x: -half - t, z: 0, hw: t, hd: half, h: CFG.WALL_H, wall: true });
  blocks.push({ x: half + t, z: 0, hw: t, hd: half, h: CFG.WALL_H, wall: true });

  // Cover: a loose grid with jitter, mirrored across the centre so the arena feels fair.
  const cells = 4;
  const cell = CFG.ARENA / cells;
  for (let gx = 0; gx < cells; gx++) {
    for (let gz = 0; gz < cells / 2; gz++) {
      if (r() < 0.22) continue;
      const cx = -half + cell * (gx + 0.5) + r.range(-cell * 0.25, cell * 0.25);
      const cz = -half + cell * (gz + 0.5) + r.range(-cell * 0.25, cell * 0.25);
      const kind = r();
      let hw, hd, h;
      if (kind < 0.35) { hw = r.range(2.2, 3.6); hd = r.range(0.6, 1.0); h = r.range(2.4, 3.2); }      // wall slab
      else if (kind < 0.7) { hw = r.range(1.0, 1.8); hd = r.range(1.0, 1.8); h = r.range(2.2, 3.4); }   // pillar
      else { hw = r.range(1.4, 2.6); hd = r.range(1.4, 2.6); h = r.range(0.9, 1.3); }                   // low crate (jumpable)
      if (r() < 0.5) [hw, hd] = [hd, hw];
      blocks.push({ x: cx, z: cz, hw, hd, h, tone: r.int(0, 2) });
      blocks.push({ x: -cx, z: -cz, hw, hd, h, tone: r.int(0, 2) });       // point mirror
    }
  }
  // Centre plinth: a tall landmark you can orient by.
  blocks.push({ x: 0, z: 0, hw: 1.2, hd: 1.2, h: 3.8, tone: 1, landmark: true });

  // Spawn candidates: ring of points plus the inner lanes; filtered against blocks.
  const spawns = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rad = i % 2 ? half - 5 : half - 13;
    const p = { x: Math.cos(a) * rad, z: Math.sin(a) * rad };
    if (!blocks.some(b => pointInBlockXZ(p.x, p.z, b, CFG.PLAYER_R + 0.6))) spawns.push(p);
  }
  return { seed, half, blocks, spawns, palette };
}

export function pointInBlockXZ(x, z, b, pad = 0) {
  return Math.abs(x - b.x) <= b.hw + pad && Math.abs(z - b.z) <= b.hd + pad;
}

// Move a player (position p = {x,y,z}, vy) by velocity over dt seconds, sliding along blocks.
// Mutates and returns p. Player is a vertical cylinder of radius PLAYER_R standing on its feet at p.y.
export function stepPlayer(p, vx, vz, dt, map, input) {
  const R = CFG.PLAYER_R;
  // Vertical first.
  p.vy = (p.vy ?? 0) - CFG.GRAVITY * dt;
  const prevY = p.y;
  p.y += p.vy * dt;
  let ground = 0;
  for (const b of map.blocks) {
    if (pointInBlockXZ(p.x, p.z, b, R * 0.7) && prevY >= b.h - 0.02 && p.y <= b.h) ground = Math.max(ground, b.h);
  }
  if (p.y <= ground) { p.y = ground; p.vy = 0; p.onGround = true; } else p.onGround = false;
  if (input?.jump && p.onGround) { p.vy = CFG.JUMP_V; p.onGround = false; }

  // Horizontal, axis by axis so we slide along faces.
  p.x += vx * dt;
  for (const b of map.blocks) if (p.y < b.h - 0.05 && pointInBlockXZ(p.x, p.z, b, R)) {
    p.x = p.x > b.x ? b.x + b.hw + R : b.x - b.hw - R;
  }
  p.z += vz * dt;
  for (const b of map.blocks) if (p.y < b.h - 0.05 && pointInBlockXZ(p.x, p.z, b, R)) {
    p.z = p.z > b.z ? b.z + b.hd + R : b.z - b.hd - R;
  }
  const lim = map.half - R;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
  return p;
}

// Does the segment a->b pass through any block? (slab test per box)
export function segmentBlocked(a, b, map) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  for (const blk of map.blocks) {
    if (blk.wall) continue; // players are always inside the walls
    let t0 = 0, t1 = 1;
    const axes = [
      [a.x, dx, blk.x - blk.hw, blk.x + blk.hw],
      [a.z, dz, blk.z - blk.hd, blk.z + blk.hd],
      [a.y, dy, -1, blk.h],
    ];
    let hit = true;
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { hit = false; break; } continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

// Does segment a->b pass within `radius` of point c? (used for smoke)
export function segmentHitsSphere(a, b, c, radius) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz || 1e-9;
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy + (c.z - a.z) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + dx * t - c.x, py = a.y + dy * t - c.y, pz = a.z + dz * t - c.z;
  return px * px + py * py + pz * pz <= radius * radius;
}

export function forwardFromYawPitch(yaw, pitch) {
  // yaw 0 looks down -Z (three.js convention); positive yaw turns left.
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
