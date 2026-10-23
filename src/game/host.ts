import type { Msg, Player } from "../net/protocol";
import { packBodies, type Body, type Frame, type SimEvent, KIND_COIN, KIND_PRIZE } from "../sim/frame";
import type { Out } from "../sim/world";
import {
  addPlayer,
  allOut,
  canDrop,
  coinLost,
  coinWon,
  createGame,
  endGame,
  prizeWon,
  rematch,
  removePlayer,
  startGame,
  takeCoin,
  type GameState,
} from "./dozer";
import {
  chuteX,
  clamp01,
  clampAim,
  DROP_COOLDOWN_MS,
  END_QUIET_MS,
  laneAt,
  PRIZE_POINTS,
  SOLO_SHAKE,
  SYNC_SHAKE,
  SYNC_WINDOW_MS,
  TILT_DRAIN_PER_S,
  TILT_LOCK_MS,
  TILT_PER_SHAKE,
} from "./rules";

export const PLAYER_COLORS = ["#e63946", "#2a9d8f", "#f4a261", "#457b9d", "#9b5de5", "#f15bb5", "#00b4d8", "#80b918"];

/** A frame goes out this often (~15 Hz). */
export const FRAME_MS = 66;
/** Every this many frames, send every body, so late joiners and lost deltas catch up. */
const KEYFRAME_EVERY = 30;
/** One player can't shake more often than this. */
const SHAKE_COOLDOWN_MS = 450;
const MAX_NAME = 24;
/** Ids are 16 hex chars (see identityKey.ts). */
const REMOTE_ID_RE = /^[0-9a-f]{16}$/;

/** The parts of the physics (src/sim/world.ts) the host drives. Tests use a fake. */
export interface Sim {
  locked: boolean;
  readonly time: number;
  readonly pusherZ: number;
  reset(seed: number): void;
  restore(bodies: Body[], time: number): void;
  drop(x: number, aim: number, power: number, spin: number): number | null;
  shake(strength: number): void;
  step(dt: number): void;
  takeOuts(): Out[];
  takeTower(): boolean;
  delta(key: boolean): { bodies: Body[]; gone: number[] };
}

export type HostDeps = {
  /** The host's own player id. */
  selfId: string;
  now?: () => number;
  newId?: () => string;
  newSeed?: () => number;
};

export function sanitizeName(name: unknown): string {
  const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME) : "";
  return clean || "Player";
}

function sanitizeAvatar(url: unknown): string | undefined {
  return typeof url === "string" && /^https:\/\/cdn\.discordapp\.com\//.test(url) ? url : undefined;
}

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** What the last frame said, so a new host can carry on from it. */
export type Carry = { bodies: Body[]; time: number; tilt: number; locked: number };

/**
 * The authoritative game, run only by the current network host. Every method
 * returns the messages to broadcast; it never touches the network itself.
 */
export class HostAuthority {
  players: Player[] = [];
  game: GameState = createGame();
  /** Tilt meter, 0–100. */
  tilt = 0;
  /** When the tilt lock ends (host clock), 0 if unlocked. */
  lockedUntil = 0;
  private sim: Sim | null = null;
  private pendingReset = false;
  private events: SimEvent[] = [];
  private seq = 0;
  private lastFrameAt = 0;
  private lastTick = 0;
  private forceKey = true;
  private lastDrop = new Map<string, number>();
  private lastShake = new Map<string, number>();
  private shakeWindow: { closes: number; by: string[] } | null = null;
  private quietSince: number | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly newSeed: () => number;

  constructor(private readonly deps: HostDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.newSeed = deps.newSeed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
    this.lastTick = this.now();
  }

  /** Take over from a previous host using the last state everyone agreed on. */
  restore(players: Player[], game: GameState) {
    this.players = players.map((p) => ({ ...p }));
    this.game = game;
  }

  /**
   * The physics is ready. `carry` is the last frame seen, after a host
   * migration; without one, the shelf starts fresh.
   */
  attachSim(sim: Sim, carry?: Carry) {
    this.sim = sim;
    if (carry && carry.bodies.length && !this.pendingReset) {
      sim.restore(carry.bodies, carry.time);
      this.tilt = carry.tilt;
      this.lockedUntil = carry.locked > 0 ? this.now() + carry.locked : 0;
    } else {
      sim.reset(this.newSeed());
    }
    this.pendingReset = false;
    this.forceKey = true;
    this.syncLock();
  }

  get simReady() {
    return this.sim !== null;
  }

  get isLocked() {
    return this.lockedUntil > this.now();
  }

  state(): Msg {
    return { t: "state", players: this.players, game: this.game, hostId: this.deps.selfId };
  }

  join(from: string, hello: { name?: unknown; avatarUrl?: unknown }): Msg[] {
    const existing = this.players.find((p) => p.id === from);
    const name = sanitizeName(hello.name);
    const avatarUrl = sanitizeAvatar(hello.avatarUrl);
    if (existing) {
      existing.name = name;
      existing.avatarUrl = avatarUrl;
    } else {
      const used = new Set(this.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.players.length % PLAYER_COLORS.length];
      const joinedAt = Math.max(this.now(), ...this.players.map((p) => p.joinedAt + 1));
      this.players.push({ id: from, name, avatarUrl, color, joinedAt });
      this.game = addPlayer(this.game, from);
    }
    this.forceKey = true;
    return [this.state()];
  }

  leave(id: string): Msg[] {
    if (!this.players.some((p) => p.id === id)) return [];
    this.players = this.players.filter((p) => p.id !== id);
    this.game = removePlayer(this.game, id);
    return [this.state()];
  }

  /** Drop everyone not in `present` (used after a host migration). */
  prune(present: Set<string>): Msg[] {
    const gone = this.players.filter((p) => !present.has(p.id)).map((p) => p.id);
    return gone.length ? gone.flatMap((id) => this.leave(id)).slice(-1) : [];
  }

  start(coinsEach: number): Msg[] {
    if (this.game.phase === "playing" || this.players.length === 0) return [];
    this.game = this.game.phase === "over" ? rematch(this.game, this.newId()) : startGame(this.game, coinsEach, this.newId());
    this.freshShelf();
    return [this.state()];
  }

  rematch(): Msg[] {
    if (this.game.phase !== "over") return [];
    return this.start(this.game.coinsEach);
  }

  private freshShelf() {
    this.tilt = 0;
    this.lockedUntil = 0;
    this.shakeWindow = null;
    this.quietSince = null;
    this.events = [];
    this.forceKey = true;
    if (this.sim) this.sim.reset(this.newSeed());
    else this.pendingReset = true;
    this.syncLock();
  }

  /** The pusher only runs while a game is on and the shelf isn't tilted. */
  private syncLock() {
    if (this.sim) this.sim.locked = this.game.phase !== "playing" || this.isLocked;
  }

  /** `from` launches a coin from their chute. */
  drop(from: string, aim: unknown, power: unknown, spin: unknown): Msg[] {
    const t = this.now();
    if (!this.sim || this.isLocked || !canDrop(this.game, from)) return [];
    if (t - (this.lastDrop.get(from) ?? -Infinity) < DROP_COOLDOWN_MS) return [];
    const lane = this.game.order.indexOf(from);
    const id = this.sim.drop(chuteX(lane, this.game.order.length), clampAim(num(aim)), clamp01(num(power, 0.5)), Math.max(-1, Math.min(1, num(spin))));
    if (id === null) return [];
    this.lastDrop.set(from, t);
    this.game = takeCoin(this.game, from);
    this.events.push({ k: "drop", by: from });
    return [this.state()];
  }

  /** `from` jerked their phone up: a shelf shake, stronger if someone else shakes with them. */
  shake(from: string): Msg[] {
    const t = this.now();
    if (!this.sim || this.game.phase !== "playing" || this.isLocked || !this.game.order.includes(from)) return [];
    if (t - (this.lastShake.get(from) ?? -Infinity) < SHAKE_COOLDOWN_MS) return [];
    this.lastShake.set(from, t);
    if (!this.shakeWindow) this.shakeWindow = { closes: t + SYNC_WINDOW_MS, by: [] };
    if (!this.shakeWindow.by.includes(from)) this.shakeWindow.by.push(from);
    return [];
  }

  private closeShake() {
    const w = this.shakeWindow!;
    this.shakeWindow = null;
    if (!this.sim || this.isLocked) return;
    const together = w.by.length >= 2 || this.game.order.length <= 1;
    const strength = together ? SYNC_SHAKE : SOLO_SHAKE;
    this.sim.shake(strength);
    this.events.push({ k: "shake", by: w.by, strength });
    this.tilt = Math.min(100, this.tilt + TILT_PER_SHAKE * w.by.length);
    if (this.tilt >= 100) {
      this.lockedUntil = this.now() + TILT_LOCK_MS;
      this.events.push({ k: "tilt" });
      this.syncLock();
    }
  }

  private count(outs: Out[]): boolean {
    let changed = false;
    const n = this.game.order.length;
    for (const o of outs) {
      const before = this.game;
      if (o.kind === KIND_COIN) {
        if (o.tray) {
          const lane = laneAt(o.x, n);
          this.game = coinWon(this.game, lane);
          this.events.push({ k: "won", x: o.x, lane });
        } else {
          this.game = coinLost(this.game);
          this.events.push({ k: "lost", x: o.x });
        }
      } else {
        const tier = o.kind - KIND_PRIZE;
        const points = PRIZE_POINTS[Math.max(0, Math.min(PRIZE_POINTS.length - 1, tier))];
        if (o.tray) {
          this.game = prizeWon(this.game, points);
          this.events.push({ k: "prize", x: o.x, tier, points });
        } else this.events.push({ k: "prize-lost", x: o.x, tier });
      }
      changed ||= this.game !== before;
    }
    return changed;
  }

  /**
   * Run the shelf. Called often (every animation frame or so) by the host's
   * room; returns a state message when the count changes and a frame ~15 Hz.
   */
  tick(): Msg[] {
    const t = this.now();
    const dt = Math.min(0.1, Math.max(0, (t - this.lastTick) / 1000));
    this.lastTick = t;
    if (!this.sim) return [];
    const out: Msg[] = [];
    let changed = false;

    if (this.shakeWindow && t >= this.shakeWindow.closes) this.closeShake();
    if (this.lockedUntil && t >= this.lockedUntil) {
      this.lockedUntil = 0;
      this.tilt = 0;
      this.events.push({ k: "unlock" });
      this.syncLock();
    } else if (this.isLocked) {
      this.tilt = (100 * (this.lockedUntil - t)) / TILT_LOCK_MS;
    } else {
      this.tilt = Math.max(0, this.tilt - TILT_DRAIN_PER_S * dt);
    }

    this.sim.step(dt);
    changed = this.count(this.sim.takeOuts());
    if (this.sim.takeTower()) this.events.push({ k: "tower" });

    if (this.game.phase === "playing") {
      if (!allOut(this.game)) this.quietSince = null;
      else {
        this.quietSince ??= t;
        if (t - this.quietSince >= END_QUIET_MS) {
          this.game = endGame(this.game);
          this.syncLock();
          changed = true;
        }
      }
    }
    if (changed) out.push(this.state());

    if (t - this.lastFrameAt >= FRAME_MS) {
      this.lastFrameAt = t;
      out.push({ t: "frame", f: this.frame() });
    }
    return out;
  }

  private frame(): Frame {
    const key = this.forceKey || this.seq % KEYFRAME_EVERY === 0;
    this.forceKey = false;
    const { bodies, gone } = this.sim!.delta(key);
    const events = this.events;
    this.events = [];
    return {
      seq: this.seq++,
      ms: Math.round(this.sim!.time * 1000),
      gameId: this.game.gameId,
      pusher: this.sim!.pusherZ,
      tilt: Math.round(this.tilt * 10) / 10,
      locked: Math.max(0, this.lockedUntil - this.now()),
      key,
      bodies: packBodies(bodies),
      gone,
      events,
    };
  }

  /** Make `remoteId` the player's phone remote. A remote belongs to one player at a time. */
  pair(from: string, remoteId: unknown): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player || typeof remoteId !== "string" || !REMOTE_ID_RE.test(remoteId)) return [];
    if (this.players.some((p) => p.id === remoteId)) return [];
    for (const p of this.players) {
      if (p.remoteId === remoteId) {
        delete p.remoteId;
        delete p.remoteOnline;
      }
    }
    player.remoteId = remoteId;
    player.remoteOnline = false;
    return [this.state()];
  }

  unpair(from: string): Msg[] {
    const player = this.players.find((p) => p.id === from);
    if (!player?.remoteId) return [];
    delete player.remoteId;
    delete player.remoteOnline;
    return [this.state()];
  }

  /** Called with everyone connected; updates the 📱 badges. */
  remotesOnline(connected: Set<string>): Msg[] {
    let changed = false;
    for (const p of this.players) {
      if (!p.remoteId) continue;
      const online = connected.has(p.remoteId);
      if (p.remoteOnline !== online) {
        p.remoteOnline = online;
        changed = true;
      }
    }
    return changed ? [this.state()] : [];
  }

  /** The player a phone remote plays for. */
  ownerOf(remoteId: string): Player | undefined {
    return this.players.find((p) => p.remoteId === remoteId);
  }

  /**
   * Requests addressed to the host. Broadcast-only messages are ignored.
   * A phone remote (`remote`, set by the transport) may only ask for the
   * state, drop and shake for the player it's paired with.
   */
  handle(from: string, msg: Msg, remote = false): Msg[] {
    if (remote) {
      if (msg.t === "remote-hello") {
        this.forceKey = true;
        return [this.state()];
      }
      const owner = this.ownerOf(from);
      if (!owner) return [];
      if (msg.t === "drop") return this.drop(owner.id, msg.aim, msg.power, msg.spin);
      if (msg.t === "shake") return this.shake(owner.id);
      return [];
    }
    switch (msg.t) {
      case "hello":
        return this.join(from, msg.player ?? {});
      case "drop":
        return this.drop(from, msg.aim, msg.power, msg.spin);
      case "shake":
        return this.shake(from);
      case "pair":
        return this.pair(from, msg.remoteId);
      case "unpair":
        return this.unpair(from);
      default:
        return [];
    }
  }
}
