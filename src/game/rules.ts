/**
 * The Carnival Dozer's rules and cabinet, in one place. Lengths are metres,
 * times milliseconds unless the name says otherwise.
 */

/** Coins each player starts with. The host picks one. */
export const COIN_OPTIONS = [20, 30, 50] as const;
export const DEFAULT_COINS = 30;

/** Points for each prize in the tower, bottom to top. */
export const PRIZE_POINTS = [10, 20, 30, 50] as const;

/** The fastest a player may drop coins (host enforced). */
export const DROP_COOLDOWN_MS = 350;

/** Shakes from different players this close together count as one synchronized shake. */
export const SYNC_WINDOW_MS = 300;
/** Each shaking player adds this much to the tilt meter (0–100). */
export const TILT_PER_SHAKE = 30;
/** The tilt meter drains this much per second. */
export const TILT_DRAIN_PER_S = 12;
/** A full meter locks the shelf this long. */
export const TILT_LOCK_MS = 5_000;
/** A shake by one player when others are at the table: a gentle nudge. */
export const SOLO_SHAKE = 1;
/** A synchronized shake (or any shake when you play alone): a hard nudge. */
export const SYNC_SHAKE = 3;

/** With everyone out of coins, the game ends once no coin has come back for this long. */
export const END_QUIET_MS = 8_000;

/** The cabinet. */
export const TABLE = {
  /** Playfield width (x from −halfWidth to +halfWidth). */
  halfWidth: 0.3,
  /** The front edge of the playfield. Coins past it fall out. */
  frontZ: 0.25,
  /** The back wall's front face; the pusher slides under it. */
  backZ: -0.25,
  /** The pusher's top surface. */
  pusherTop: 0.04,
  /** The pusher's front face sweeps between these. */
  pusherMinZ: -0.2,
  pusherMaxZ: -0.08,
  /** One stroke out and back. */
  pusherPeriodS: 3.6,
  /** Coins falling off the front within this |x| land in the win tray; outside it, the side gutters keep them. */
  trayHalfWidth: 0.21,
  /** Chute mouths sit this high, just in front of the back wall. */
  chuteY: 0.16,
  /** The chute turns at most this far either way (radians). */
  maxAim: (30 * Math.PI) / 180,
} as const;

export const COIN = { radius: 0.022, thickness: 0.008 } as const;

/** Coins on the table at the start of a game. */
export const START_PILE = 190;

/**
 * Where each player's chute sits along the back wall, spread evenly in join
 * order. Coins that fall into the tray are credited to the nearest chute.
 */
export function chuteX(index: number, count: number): number {
  const span = TABLE.halfWidth * 0.8;
  if (count <= 1) return 0;
  return -span + (2 * span * index) / (count - 1);
}

/** The player (index in join order) whose chute is nearest `x`. */
export function laneAt(x: number, count: number): number {
  let best = 0;
  for (let i = 1; i < count; i++) if (Math.abs(chuteX(i, count) - x) < Math.abs(chuteX(best, count) - x)) best = i;
  return best;
}

export function clampAim(a: number): number {
  if (!Number.isFinite(a)) return 0;
  return Math.max(-TABLE.maxAim, Math.min(TABLE.maxAim, a));
}

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
