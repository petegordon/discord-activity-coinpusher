import {
  applyDelta,
  combine,
  emptyLifetime,
  lifetimeEarned,
  mergeDeltas,
  Referee,
  toLifetime,
  type Credit,
  type Delta,
  type Lifetime,
} from "../../src/achievements/referee";
import type { GameState } from "../../src/game/dozer";
import type { SimEvent } from "../../src/sim/frame";

export const GAME = "coins";
/** One account is saved at most this often while playing (achievements a bit sooner). */
export const FLUSH_MS = 2_000;
export const FLUSH_EARNED_MS = 800;

/** The account service's achievement calls (Tandemonium's HouseTandemGames entrypoint). */
export type GamesService = {
  gameProfile(userId: string, game: string): Promise<{ earned: string[]; stats: Record<string, unknown> }>;
  recordGame(userId: string, game: string, delta: Delta, earned: string[]): Promise<{ newlyEarned: string[] }>;
};

export type ScorekeeperDeps = {
  ht?: GamesService;
  /** Tell everyone at the table that `playerId` just earned `ids`. */
  toast: (playerId: string, ids: string[]) => void;
  /** Keep the Durable Object alive for background work. */
  wait?: (p: Promise<unknown>) => void;
  log?: (...args: unknown[]) => void;
};

type Account = {
  base: Lifetime | null;
  session: Lifetime;
  earned: Set<string>;
  loading: Promise<void>;
  /** Not saved yet. */
  pending: { playerId: string; delta: Delta; earned: Set<string> } | null;
  lastFlush: number;
  saving: boolean;
};

/**
 * The relay room's side of Carnival Dozer achievements: feeds what passes
 * through the relay to the Referee (src/achievements/referee.ts, which holds
 * the trust model), then saves each signed-in player's share to their House
 * Tandem account and toasts what was new. Guests earn nothing.
 */
export class Scorekeeper {
  readonly referee = new Referee();
  private byUser = new Map<string, Account>();

  constructor(private readonly deps: ScorekeeperDeps) {}

  /** The relay's view: who's host, and which players are signed in (verified sockets only). */
  seat(hostId: string | null, accounts: Map<string, string>) {
    this.referee.hostId = hostId;
    this.referee.accounts = accounts;
  }

  request(playerId: string, msg: { t: string; aim?: unknown }, phone: boolean, now: number) {
    this.referee.request(playerId, msg, phone, now);
  }

  state(game: GameState, now: number) {
    this.credit(this.referee.state(game, now), now, true);
  }

  frame(events: SimEvent[], now: number) {
    this.credit(this.referee.frame(events, now), now, false);
  }

  /** Save everything pending now (the room is emptying). */
  flushAll(now: number) {
    for (const [userId, acc] of this.byUser) this.flush(userId, acc, now, true);
  }

  private account(userId: string): Account {
    let a = this.byUser.get(userId);
    if (a) return a;
    const fresh: Account = { base: null, session: emptyLifetime(), earned: new Set(), loading: Promise.resolve(), pending: null, lastFlush: -Infinity, saving: false };
    if (this.deps.ht) {
      fresh.loading = this.deps.ht
        .gameProfile(userId, GAME)
        .then((p) => {
          fresh.base = toLifetime(p.stats);
          for (const id of p.earned ?? []) fresh.earned.add(id);
        })
        .catch((e) => this.deps.log?.("gameProfile failed", e));
    }
    this.byUser.set(userId, fresh);
    return fresh;
  }

  private credit(credits: Credit[], now: number, force: boolean) {
    if (!this.deps.ht) return;
    const touched = new Set<string>();
    for (const c of credits) {
      const userId = this.referee.accounts.get(c.playerId);
      if (!userId) continue; // guests earn nothing
      const acc = this.account(userId);
      acc.session = applyDelta(acc.session, c.delta);
      const p = (acc.pending ??= { playerId: c.playerId, delta: {}, earned: new Set() });
      p.playerId = c.playerId;
      p.delta = mergeDeltas(p.delta, c.delta);
      for (const id of c.earned) p.earned.add(id);
      touched.add(userId);
    }
    for (const [userId, acc] of this.byUser) {
      if (acc.pending && (force || touched.has(userId) || now - acc.lastFlush >= FLUSH_MS)) this.flush(userId, acc, now, force);
    }
  }

  private flush(userId: string, acc: Account, now: number, force: boolean) {
    const ht = this.deps.ht;
    const p = acc.pending;
    if (!ht || !p || acc.saving) return;
    const hasNew = [...p.earned].some((id) => !acc.earned.has(id));
    const wait = hasNew ? FLUSH_EARNED_MS : FLUSH_MS;
    if (!force && now - acc.lastFlush < wait) return;
    acc.pending = null;
    acc.lastFlush = now;
    acc.saving = true;
    const work = (async () => {
      await acc.loading;
      const earned = new Set(p.earned);
      if (acc.base) for (const id of lifetimeEarned(combine(acc.base, acc.session))) earned.add(id);
      const claim = [...earned].filter((id) => !acc.earned.has(id));
      for (const id of claim) acc.earned.add(id);
      const hasDelta = Object.keys(p.delta).length > 0;
      if (!claim.length && !hasDelta) return;
      try {
        const res = await ht.recordGame(userId, GAME, p.delta, claim);
        const fresh = (res?.newlyEarned ?? []).filter((x) => typeof x === "string");
        if (fresh.length) this.deps.toast(p.playerId, fresh);
      } catch (e) {
        for (const id of claim) acc.earned.delete(id);
        // Keep the progress for the next save.
        acc.pending = acc.pending
          ? { playerId: acc.pending.playerId, delta: mergeDeltas(p.delta, acc.pending.delta), earned: new Set([...p.earned, ...acc.pending.earned]) }
          : p;
        this.deps.log?.("recordGame failed", e);
      } finally {
        acc.saving = false;
      }
    })();
    this.deps.wait?.(work);
  }
}
