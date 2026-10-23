import { describe, expect, it } from "vitest";
import { addPlayer, allOut, coinLost, coinWon, createGame, endGame, prizeWon, rematch, removePlayer, startGame, takeCoin } from "../src/game/dozer";
import { chuteX, clampAim, laneAt, TABLE } from "../src/game/rules";

const table = (...ids: string[]) => ids.reduce(addPlayer, createGame());

describe("the game", () => {
  it("gives everyone the chosen coins when it starts, and ignores odd choices", () => {
    const g = startGame(table("a", "b"), 20, "g1");
    expect(g).toMatchObject({ phase: "playing", gameId: "g1", coinsEach: 20, coins: { a: 20, b: 20 } });
    expect(startGame(table("a"), 7, "g2").coinsEach).toBe(30);
  });

  it("takes a coin per drop and refuses with none left", () => {
    let g = startGame(table("a"), 20, "g");
    for (let i = 0; i < 20; i++) g = takeCoin(g, "a");
    expect(g.coins.a).toBe(0);
    expect(g.dropped).toBe(20);
    expect(takeCoin(g, "a")).toBe(g);
    expect(allOut(g)).toBe(true);
    expect(takeCoin(startGame(table("a"), 20, "g"), "zed").coins.zed).toBeUndefined();
  });

  it("gives tray coins to the lane's player and counts gutters and prizes for the team", () => {
    let g = startGame(table("a", "b"), 20, "g");
    g = coinWon(g, 1);
    g = coinLost(g);
    g = prizeWon(g, 50);
    expect(g.coins).toEqual({ a: 20, b: 21 });
    expect(g).toMatchObject({ coinsWon: 1, coinsLost: 1, score: 50, prizes: 1 });
    // Nothing counts before or after a game.
    expect(prizeWon(createGame(), 50).score).toBe(0);
    expect(coinWon(endGame(g), 0).coins.a).toBe(20);
  });

  it("keeps a leaver's coins for when they come back, and gives a newcomer a full hand", () => {
    let g = startGame(table("a", "b"), 30, "g");
    g = takeCoin(takeCoin(g, "b"), "b");
    g = removePlayer(g, "b");
    expect(g.order).toEqual(["a"]);
    g = addPlayer(g, "c");
    g = addPlayer(g, "b");
    expect(g.coins).toEqual({ a: 30, c: 30, b: 28 });
  });

  it("starts a rematch fresh with the same coins", () => {
    let g = startGame(table("a"), 50, "g");
    g = endGame(prizeWon(takeCoin(g, "a"), 10));
    const r = rematch(g, "g2");
    expect(r).toMatchObject({ phase: "playing", gameId: "g2", coins: { a: 50 }, score: 0, dropped: 0 });
  });
});

describe("chutes and lanes", () => {
  it("spreads chutes across the back, one alone in the middle", () => {
    expect(chuteX(0, 1)).toBe(0);
    const xs = [0, 1, 2, 3].map((i) => chuteX(i, 4));
    expect(xs[0]).toBeCloseTo(-xs[3]);
    for (const x of xs) expect(Math.abs(x)).toBeLessThan(TABLE.halfWidth);
  });

  it("credits the tray to the nearest chute", () => {
    expect(laneAt(-0.2, 2)).toBe(0);
    expect(laneAt(0.2, 2)).toBe(1);
    expect(laneAt(0.01, 3)).toBe(1);
    expect(laneAt(0.3, 1)).toBe(0);
  });

  it("limits the aim", () => {
    expect(clampAim(5)).toBe(TABLE.maxAim);
    expect(clampAim(Number.NaN)).toBe(0);
  });
});
