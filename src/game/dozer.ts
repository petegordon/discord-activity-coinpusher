import { COIN_OPTIONS, DEFAULT_COINS } from "./rules";

export type Phase = "lobby" | "playing" | "over";

/**
 * Everything about a game that isn't physics. The coins and prizes on the
 * shelf live in the host's simulation and reach everyone as frames
 * (src/sim/frame.ts); this changes only when something is counted.
 */
export type GameState = {
  phase: Phase;
  /** New for every game, so every client knows the shelf was reset. */
  gameId: string;
  /** Coins each player starts with. */
  coinsEach: number;
  /** Players at the table in join order. A player's place sets their chute and lane. */
  order: string[];
  /** Coins in hand. */
  coins: Record<string, number>;
  /** Coins of players who left mid-game, given back if they return. */
  kept: Record<string, number>;
  /** The team's points, from prizes. */
  score: number;
  prizes: number;
  /** Coins that fell into the win tray (and went back into someone's hand). */
  coinsWon: number;
  /** Coins that fell into the side gutters. */
  coinsLost: number;
  dropped: number;
};

export function createGame(): GameState {
  return { phase: "lobby", gameId: "", coinsEach: DEFAULT_COINS, order: [], coins: {}, kept: {}, score: 0, prizes: 0, coinsWon: 0, coinsLost: 0, dropped: 0 };
}

export function addPlayer(g: GameState, id: string): GameState {
  if (g.order.includes(id)) return g;
  const { [id]: back, ...kept } = g.kept;
  const coins = g.phase === "playing" ? (back ?? g.coinsEach) : g.coinsEach;
  return { ...g, order: [...g.order, id], coins: { ...g.coins, [id]: coins }, kept };
}

export function removePlayer(g: GameState, id: string): GameState {
  if (!g.order.includes(id)) return g;
  const { [id]: had = 0, ...coins } = g.coins;
  const kept = g.phase === "playing" ? { ...g.kept, [id]: had } : g.kept;
  return { ...g, order: g.order.filter((p) => p !== id), coins, kept };
}

export function startGame(g: GameState, coinsEach: number, gameId: string): GameState {
  const each = (COIN_OPTIONS as readonly number[]).includes(coinsEach) ? coinsEach : g.coinsEach;
  return {
    ...createGame(),
    phase: "playing",
    gameId,
    coinsEach: each,
    order: g.order,
    coins: Object.fromEntries(g.order.map((id) => [id, each])),
  };
}

export function rematch(g: GameState, gameId: string): GameState {
  return startGame(g, g.coinsEach, gameId);
}

export function canDrop(g: GameState, id: string): boolean {
  return g.phase === "playing" && (g.coins[id] ?? 0) > 0;
}

/** A coin leaves `id`'s hand for the chute. Unchanged if they can't drop. */
export function takeCoin(g: GameState, id: string): GameState {
  if (!canDrop(g, id)) return g;
  return { ...g, coins: { ...g.coins, [id]: g.coins[id] - 1 }, dropped: g.dropped + 1 };
}

/** A coin fell into the tray in front of lane `lane`; it goes to that player's hand. */
export function coinWon(g: GameState, lane: number): GameState {
  if (g.phase !== "playing") return g;
  const id = g.order[Math.max(0, Math.min(g.order.length - 1, lane))];
  if (!id) return { ...g, coinsWon: g.coinsWon + 1 };
  return { ...g, coins: { ...g.coins, [id]: (g.coins[id] ?? 0) + 1 }, coinsWon: g.coinsWon + 1 };
}

export function coinLost(g: GameState): GameState {
  if (g.phase !== "playing") return g;
  return { ...g, coinsLost: g.coinsLost + 1 };
}

export function prizeWon(g: GameState, points: number): GameState {
  if (g.phase !== "playing") return g;
  return { ...g, score: g.score + points, prizes: g.prizes + 1 };
}

/** Nobody at the table has a coin left to drop. */
export function allOut(g: GameState): boolean {
  return g.order.every((id) => (g.coins[id] ?? 0) === 0);
}

export function endGame(g: GameState): GameState {
  return g.phase === "playing" ? { ...g, phase: "over" } : g;
}

export function coinsInHand(g: GameState): number {
  return Object.values(g.coins).reduce((a, b) => a + b, 0);
}
