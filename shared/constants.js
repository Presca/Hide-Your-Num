// Tunables shared by the match server (Cloudflare Durable Object), the in-browser practice mode
// and the renderer. Distances are metres, times are milliseconds, speeds are metres per second.
export const CFG = {
  MAX_PLAYERS: 20,
  TICK_MS: 50,                 // server simulation + snapshot rate (20 Hz); outgoing messages are free
  INPUT_MS: 100,               // client input rate (10 Hz); incoming messages count against the free quota
  PING_MS: 5_000,
  ROUND_MS: 4 * 60_000,        // one round
  INTERMISSION_MS: 12_000,     // scoreboard between rounds
  RESPAWN_MS: 3_000,
  CODE_DIGITS: 5,              // the number on your forehead

  ARENA: 64,                   // arena is ARENA x ARENA, centred on the origin
  WALL_H: 4,
  PLAYER_R: 0.42,
  PLAYER_H: 1.8,
  EYE_H: 1.62,
  FOREHEAD_H: 1.68,
  WALK_SPEED: 6.2,
  JUMP_V: 6.4,
  GRAVITY: 18,

  READ_RANGE: 30,              // how far you can read a forehead
  READ_CONE_DEG: 32,           // half-angle: target must be this close to the crosshair
  FACE_CONE_DEG: 80,           // half-angle: target must be facing you this much (number is on the FRONT)
  TYPE_LOCKOUT_MS: 900,        // penalty after typing a code nobody wears
  TYPE_LOCKOUT_SIGHT_MS: 450,  // shorter penalty when the code was right but the target is out of sight
  TYPE_GRACE_MS: 800,          // a code still counts this long after you last had the target in sight

  GADGETS: {
    smoke:   { key: 'Q', cd: 20_000, radius: 6.5, duration: 7_000, label: 'Smoke' },
    flash:   { key: 'E', cd: 25_000, range: 20, coneDeg: 40, duration: 2_600, label: 'Flash' },
    shuffle: { key: 'F', cd: 15_000, hidden: 1_200, label: 'Shuffle' },
  },
};

export const MSG = {
  // client -> server
  JOIN: 'join', INPUT: 'in', TYPE: 'type', GADGET: 'gadget', PING: 'ping',
  // server -> client
  WELCOME: 'welcome', STATE: 'state', YOU: 'you', EVENT: 'ev', ROUND: 'round', PONG: 'pong', ERROR: 'error',
};
