import type { GameState } from "../game/dozer";
import { COIN_OPTIONS, DROP_COOLDOWN_MS, PRIZE_POINTS, START_PILE, TABLE } from "../game/rules";
import type { SimEvent } from "../sim/frame";

/**
 * Who earned what at the Carnival Dozer, decided by the relay room.
 *
 * TRUST MODEL (Pete's option A): the coins' physics runs in one player's
 * browser (the host), so the host could invent events. The relay room never
 * takes the host's word for an achievement outright. It reads the host's
 * state and frame broadcasts as they pass through, and only credits what it
 * can check or what stays within what the cabinet can physically do:
 *
 * - **Drops.** Every non-host player's drop request passes through the relay,
 *   so a drop event for them counts only against a real request (FIFO, a few
 *   seconds old at most). That request also says whether it came from their
 *   phone (Phone Pusher) and how far it was aimed (Bank Shot), so the host
 *   can't make those up for them. The host's own drops never pass through the
 *   relay; they're capped at one per DROP_COOLDOWN_MS of game time in the room.
 * - **Shakes.** A player in a shake counts only if they sent a shake request
 *   in the last moment (the host itself: at most one per shake cooldown).
 * - **Coins won.** Never more than the coins the shelf could ever hold (start
 *   pile + stacks + counted drops), and at most WON_PER_SECOND_CAP a second.
 * - **Prizes.** Points come from the tier, not the host; each tier at most once
 *   per tower, and a new tower no sooner than MIN_TOWER_GAP_MS after the last.
 * - **A game** counts only with enough counted drops and time.
 * - **Accounts** come from the relay's own verified sockets, never the host.
 * - **Game ids** come from the host, so no cap is tied to one: the caps hold
 *   for the life of the room (see the Referee class).
 *
 * What's left (a host crediting coins to the wrong lane, or hiding a tilt) can
 * only move a player's own bragging rights a little. Moving the physics onto
 * the server (option B) would close it, at a steady CPU cost per room.
 */

export type Delta = {
  add?: Record<string, number>;
  max?: Record<string, number>;
  or?: Record<string, number>;
  union?: Record<string, string[]>;
};

/** Lifetime Carnival Dozer stats as stored on the account. */
export type Lifetime = {
  games: number;
  drops: number;
  coinsWon: number;
  prizes: number;
  phoneDrops: number;
  /** House Tandem user ids played a game with. */
  partners: string[];
};

/** One player's share of something that just happened. */
export type Credit = { playerId: string; earned: string[]; delta: Delta };

/** A drop or bank shot aimed at least this far counts as "full aim". */
export const FULL_AIM = TABLE.maxAim * 0.95;
/** Coin stacks on the front lip: at the start, and with every new tower; 3–4 coins each. */
const START_STACKS = 5;
const STACKS_PER_TOWER = 3;
const STACK_COINS = 4;
/** More coins than this into the tray in one second is beyond the cabinet. */
export const WON_PER_SECOND_CAP = 30;
/** A new tower needs the old one cleared and a 1.5 s pause; faster than this is made up. */
export const MIN_TOWER_GAP_MS = 4_000;
/** A drop or shake request is good for this long. */
const REQUEST_TTL_MS = 3_000;
const SHAKE_PROOF_MS = 1_500;
const HOST_SHAKE_GAP_MS = 400;
/** A game counts toward lifetime stats only with this many drops and this long. */
export const MIN_GAME_DROPS = 5;
export const MIN_GAME_MS = 15_000;
const PARTNER_CAP = 200;

export function emptyLifetime(): Lifetime {
  return { games: 0, drops: 0, coinsWon: 0, prizes: 0, phoneDrops: 0, partners: [] };
}

/** Read stored stats defensively: anything missing or odd becomes zero. */
export function toLifetime(stats: Record<string, unknown> | null | undefined): Lifetime {
  const s = stats ?? {};
  const n = (k: string) => (typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : 0);
  const partners = Array.isArray(s.partners) ? s.partners.filter((x): x is string => typeof x === "string") : [];
  return { games: n("games"), drops: n("drops"), coinsWon: n("coinsWon"), prizes: n("prizes"), phoneDrops: n("phoneDrops"), partners };
}

/** Apply a delta locally, the same way the account service merges it. */
export function applyDelta(l: Lifetime, d: Delta): Lifetime {
  const out: Lifetime = { ...l, partners: [...l.partners] };
  const num = out as unknown as Record<string, number>;
  for (const [k, v] of Object.entries(d.add ?? {})) num[k] = (num[k] ?? 0) + v;
  for (const [k, v] of Object.entries(d.max ?? {})) num[k] = Math.max(num[k] ?? 0, v);
  for (const [k, v] of Object.entries(d.union ?? {})) {
    if (k !== "partners") continue;
    out.partners = [...new Set([...out.partners, ...v])].slice(0, PARTNER_CAP);
  }
  return out;
}

/** Stored stats plus this session's. */
export function combine(base: Lifetime, session: Lifetime): Lifetime {
  return applyDelta(base, {
    add: { games: session.games, drops: session.drops, coinsWon: session.coinsWon, prizes: session.prizes, phoneDrops: session.phoneDrops },
    union: { partners: session.partners },
  });
}

/** Achievements that depend on lifetime totals. */
export function lifetimeEarned(l: Lifetime): string[] {
  const out: string[] = [];
  if (l.games >= 25) out.push("regular");
  if (l.coinsWon >= 1000) out.push("coin_collector");
  if (l.prizes >= 50) out.push("prize_hunter");
  if (l.partners.length >= 10) out.push("good_company");
  if (l.phoneDrops >= 25) out.push("phone_pusher");
  return out;
}

/** Combine two deltas. */
export function mergeDeltas(a: Delta, b: Delta): Delta {
  const out: Delta = {};
  for (const kind of ["add", "max", "or"] as const) {
    const m: Record<string, number> = { ...(a[kind] ?? {}) };
    for (const [k, v] of Object.entries(b[kind] ?? {})) {
      m[k] = k in m ? (kind === "add" ? m[k] + v : kind === "max" ? Math.max(m[k], v) : m[k] | v) : v;
    }
    if (Object.keys(m).length) out[kind] = m;
  }
  const u: Record<string, string[]> = { ...(a.union ?? {}) };
  for (const [k, v] of Object.entries(b.union ?? {})) u[k] = [...new Set([...(u[k] ?? []), ...v])];
  if (Object.keys(u).length) out.union = u;
  return out;
}

type Request = { at: number; fullAim: boolean; phone: boolean };

type Seat = {
  /** Drop requests seen by the relay, not yet matched to a drop event. */
  requests: Request[];
  lastShakeReq: number;
  /** On this shelf. */
  drops: number;
  fullAimDrops: number;
  bankShots: number;
  laneWon: number;
};

/**
 * What the cabinet has done since the shelf was last laid out afresh. A new
 * game lays out a new shelf, but the referee counts one at most every
 * MIN_GAME_MS: a game id that follows sooner carries on with the same shelf.
 */
type Shelf = {
  startedAt: number;
  /** Coins each player starts with (one of COIN_OPTIONS). */
  coinsEach: number;
  /** Counted drops onto this shelf. */
  drops: number;
  /** Coins that left it, won or lost. */
  out: number;
  towers: number;
  tiers: Set<number>;
  towerWon: Set<number>;
};

/** What belongs to one game id: whether it counts as a game, its score, its tilt. */
type Game = {
  id: string;
  startedAt: number;
  drops: number;
  score: number;
  hadTilt: boolean;
  ended: boolean;
};

/** Seats kept for players no longer in the order, at most. */
const MAX_SEATS = 64;

/**
 * The caps above hold for as long as the room does. The game id comes from
 * the host, so nothing that limits the host is tied to it: a new id starts a
 * new game (its score, its tilt, whether it counts as a game) and nothing
 * else. Per player, the request queues and shake proofs carry over; per room,
 * the host's drop allowance, the coins-per-second and tower pacing, and the
 * shake history do. The shelf's own limits (how many coins it can give up,
 * each player's coins, each prize tier once per tower) start again only with
 * a shelf the referee counts as new (see Shelf).
 */
export class Referee {
  private game: Game | null = null;
  private shelf: Shelf | null = null;
  private order: string[] = [];
  private seats = new Map<string, Seat>();

  /** The host's own drops, counted against the time games have been running in this room. */
  private hostDrops = 0;
  /** Milliseconds of games that are over (the running one is added from its start). */
  private playedMs = 0;
  private lastTowerAt = -Infinity;
  /** Arrival times of recent counted won coins. */
  private wonTimes: number[] = [];
  private hostLastShake = -Infinity;
  /** The last shake's counted members, for crediting a tilt. */
  private lastShake: { at: number; by: string[] } | null = null;
  /** Recent counted shake members, for checking a tilt was earned. */
  private shakeUnits: number[] = [];

  /** The player whose browser runs the shelf (from the relay's connection order). */
  hostId: string | null = null;
  /** Player id → House Tandem user id, from the relay's verified sockets. */
  accounts = new Map<string, string>();

  private seat(id: string): Seat {
    let s = this.seats.get(id);
    if (!s) {
      if (this.seats.size >= MAX_SEATS) {
        for (const old of this.seats.keys()) {
          if (this.seats.size < MAX_SEATS) break;
          if (!this.order.includes(old)) this.seats.delete(old);
        }
      }
      this.seats.set(id, (s = { requests: [], lastShakeReq: -Infinity, drops: 0, fullAimDrops: 0, bankShots: 0, laneWon: 0 }));
    }
    return s;
  }

  /** A drop or shake request from a player (or their phone), seen passing through the relay. */
  request(playerId: string, msg: { t: string; aim?: unknown }, phone: boolean, now: number) {
    if (playerId === this.hostId) return;
    const s = this.seat(playerId);
    if (msg.t === "drop") {
      const aim = typeof msg.aim === "number" && Number.isFinite(msg.aim) ? msg.aim : 0;
      s.requests.push({ at: now, fullAim: Math.abs(aim) >= FULL_AIM, phone });
      if (s.requests.length > 20) s.requests.shift();
    } else if (msg.t === "shake") s.lastShakeReq = now;
  }

  /** The host's state broadcast: a game starting, the seating, a game ending. */
  state(game: GameState, now: number): Credit[] {
    if (!game || typeof game !== "object" || !Array.isArray(game.order)) return [];
    this.order = game.order.filter((x) => typeof x === "string").slice(0, 16);
    if (game.phase === "playing" && typeof game.gameId === "string" && game.gameId && game.gameId !== this.game?.id) {
      // A game left running counts its time toward the host's drop allowance, like one that ended.
      if (this.game && !this.game.ended) this.playedMs += Math.max(0, now - this.game.startedAt);
      this.game = { id: game.gameId, startedAt: now, drops: 0, score: 0, hadTilt: false, ended: false };
      if (!this.shelf || now - this.shelf.startedAt >= MIN_GAME_MS) {
        // Players start with one of the listed amounts; anything else from the host is read as the most.
        const each = Number(game.coinsEach);
        const coinsEach = (COIN_OPTIONS as readonly number[]).includes(each) ? each : Math.max(...COIN_OPTIONS);
        this.shelf = { startedAt: now, coinsEach, drops: 0, out: 0, towers: 0, tiers: new Set(), towerWon: new Set() };
        this.lastTowerAt = now;
        for (const s of this.seats.values()) Object.assign(s, { drops: 0, fullAimDrops: 0, bankShots: 0, laneWon: 0 });
      }
      return [];
    }
    if (game.phase === "over" && this.game && game.gameId === this.game.id && !this.game.ended) return this.endGame(now, this.accounts);
    return [];
  }

  /** Players who dropped a coin in this game's shelf. */
  private participants(): string[] {
    return this.order.filter((id) => (this.seats.get(id)?.drops ?? 0) > 0);
  }

  /** The events in one of the host's frames. */
  frame(events: SimEvent[], now: number): Credit[] {
    const g = this.game;
    const sh = this.shelf;
    if (!g || !sh || g.ended || !Array.isArray(events)) return [];
    const credits: Credit[] = [];
    const give = (playerId: string, earned: string[], delta: Delta = {}) => credits.push({ playerId, earned, delta });
    for (const e of events.slice(0, 200)) {
      if (!e || typeof e !== "object") continue;
      switch (e.k) {
        case "drop": {
          const by = typeof e.by === "string" ? e.by : "";
          if (!this.order.includes(by)) break;
          const s = this.seat(by);
          let phone = false;
          let fullAim = false;
          if (by === this.hostId) {
            // The host's own drops never pass the relay: cap them by the time games have run in this room.
            const played = this.playedMs + Math.max(0, now - g.startedAt);
            if (this.hostDrops >= Math.floor(played / DROP_COOLDOWN_MS) + 2) break;
            this.hostDrops++;
            fullAim = typeof e.aim === "number" && Math.abs(e.aim) >= FULL_AIM;
          } else {
            s.requests = s.requests.filter((r) => now - r.at <= REQUEST_TTL_MS);
            const req = s.requests.shift();
            if (!req) break;
            phone = req.phone;
            fullAim = req.fullAim;
          }
          // Nobody drops more coins than they started with plus won back.
          if (s.drops >= sh.coinsEach + s.laneWon) break;
          s.drops++;
          sh.drops++;
          g.drops++;
          if (fullAim) s.fullAimDrops++;
          const add: Record<string, number> = { drops: 1 };
          if (phone) add.phoneDrops = 1;
          give(by, ["first_drop"], { add });
          break;
        }
        case "won": {
          const holds = START_PILE + STACK_COINS * (START_STACKS + STACKS_PER_TOWER * sh.towers) + sh.drops;
          if (sh.out >= holds) break;
          this.wonTimes = this.wonTimes.filter((t) => now - t < 2_000);
          if (this.wonTimes.filter((t) => now - t < 1_000).length >= WON_PER_SECOND_CAP) break;
          sh.out++;
          this.wonTimes.push(now);
          const lane = typeof e.lane === "number" ? e.lane : -1;
          const to = this.order[lane];
          if (to && this.seat(to).drops > 0) {
            const s = this.seat(to);
            s.laneWon++;
            const earned = ["into_the_tray"];
            if (s.laneWon === sh.coinsEach) earned.push("breaking_even");
            give(to, earned, { add: { coinsWon: 1 } });
          }
          const by = typeof e.by === "string" ? e.by : "";
          if (by && typeof e.aim === "number" && Math.abs(e.aim) >= FULL_AIM && this.order.includes(by)) {
            const s = this.seat(by);
            if (s.bankShots < s.fullAimDrops) {
              s.bankShots++;
              give(by, ["bank_shot"]);
            }
          }
          const inOne = this.wonTimes.filter((t) => now - t < 1_000).length;
          const shelf: string[] = [];
          if (inOne >= 10) shelf.push("jackpot");
          if (this.wonTimes.length >= 25) shelf.push("avalanche");
          if (shelf.length) for (const id of this.participants()) give(id, shelf);
          break;
        }
        case "lost":
          sh.out++;
          break;
        case "tower":
          if (now - this.lastTowerAt < MIN_TOWER_GAP_MS) break;
          sh.towers++;
          this.lastTowerAt = now;
          sh.tiers.clear();
          sh.towerWon.clear();
          break;
        case "prize":
        case "prize-lost": {
          const tier = typeof e.tier === "number" ? e.tier : -1;
          if (!Number.isInteger(tier) || tier < 0 || tier >= PRIZE_POINTS.length || sh.tiers.has(tier)) break;
          sh.tiers.add(tier);
          if (e.k === "prize-lost") break;
          sh.towerWon.add(tier);
          const before = g.score;
          g.score += PRIZE_POINTS[tier];
          const earned = ["prize_winner"];
          if (tier === PRIZE_POINTS.length - 1) earned.push("top_prize");
          if (sh.towerWon.size === PRIZE_POINTS.length) earned.push("tower_down");
          if (before < 100 && g.score >= 100) earned.push("high_score");
          if (before < 250 && g.score >= 250) earned.push("big_night");
          for (const id of this.participants()) give(id, earned, { add: { prizes: 1 } });
          break;
        }
        case "shake": {
          const by = Array.isArray(e.by) ? e.by.filter((x): x is string => typeof x === "string" && this.order.includes(x)) : [];
          const counted = [...new Set(by)].filter((id) => {
            if (id === this.hostId) {
              if (now - this.hostLastShake < HOST_SHAKE_GAP_MS) return false;
              this.hostLastShake = now;
              return true;
            }
            const s = this.seat(id);
            const ok = now - s.lastShakeReq <= SHAKE_PROOF_MS;
            if (ok) s.lastShakeReq = -Infinity;
            return ok;
          });
          if (!counted.length) break;
          this.lastShake = { at: now, by: counted };
          this.shakeUnits = [...this.shakeUnits.filter((t) => now - t < 10_000), ...counted.map(() => now)];
          const earned: string[] = [];
          if (counted.length >= 2) earned.push("in_sync");
          if (counted.length >= 4) earned.push("full_shake");
          if (earned.length) for (const id of counted) give(id, earned);
          break;
        }
        case "tilt": {
          g.hadTilt = true;
          // A full meter takes about four shakers' worth; three counted shakes is the least that could do it.
          const units = this.shakeUnits.filter((t) => now - t < 10_000).length;
          if (this.lastShake && now - this.lastShake.at < 3_000 && units >= 3) for (const id of this.lastShake.by) give(id, ["tilt"]);
          break;
        }
        default:
          break;
      }
    }
    return credits;
  }

  /**
   * The game is over. `userIds` maps player id → House Tandem user id for
   * signed-in players (Good Company counts only those).
   */
  endGame(now: number, userIds: Map<string, string> = new Map()): Credit[] {
    const g = this.game;
    if (!g || g.ended) return [];
    g.ended = true;
    this.playedMs += Math.max(0, now - g.startedAt);
    const players = this.participants();
    if (g.drops < MIN_GAME_DROPS || now - g.startedAt < MIN_GAME_MS) return [];
    const signedIn = players.map((id) => userIds.get(id)).filter((u): u is string => !!u);
    return players.map((id) => {
      const earned: string[] = [];
      if (players.length >= 2 && !g.hadTilt) earned.push("steady_hands");
      const me = userIds.get(id);
      const partners = signedIn.filter((u) => u !== me);
      const delta: Delta = { add: { games: 1 } };
      if (partners.length) delta.union = { partners };
      return { playerId: id, earned, delta };
    });
  }
}
