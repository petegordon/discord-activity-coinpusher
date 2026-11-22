// Carnival Dozer achievements: the relay room's referee credits only what it
// can check (option A: the physics stays in the host's browser), and the
// scorekeeper saves signed-in players' shares to House Tandem.
import { describe, expect, it, vi } from "vitest";
import { ACHIEVEMENTS } from "../src/achievements/defs";
import { FULL_AIM, MIN_GAME_MS, Referee, WON_PER_SECOND_CAP, type Credit } from "../src/achievements/referee";
import type { GameState } from "../src/game/dozer";
import { createGame } from "../src/game/dozer";
import { Scorekeeper } from "../worker/src/scorekeeper";

const playing = (order: string[], gameId = "g1", coinsEach = 30): GameState => ({ ...createGame(), phase: "playing", gameId, order, coinsEach, coins: Object.fromEntries(order.map((id) => [id, coinsEach])) });
const ids = (cs: Credit[], who: string) => cs.filter((c) => c.playerId === who).flatMap((c) => c.earned);

/** A table: host "h", players "a" "b" "c"; game started at t=0. */
function table(order = ["h", "a", "b", "c"]) {
  const r = new Referee();
  r.hostId = "h";
  r.state(playing(order), 0);
  return r;
}
/** Player drops (request through the relay, then the host's event). */
function drop(r: Referee, who: string, t: number, opts: { aim?: number; phone?: boolean } = {}) {
  if (who !== "h") r.request(who, { t: "drop", aim: opts.aim ?? 0 }, !!opts.phone, t);
  return r.frame([{ k: "drop", by: who, aim: opts.aim ?? 0 }], t);
}

describe("the 20 Carnival Dozer achievements", () => {
  it("are listed with unique ids in four groups", () => {
    expect(ACHIEVEMENTS).toHaveLength(20);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(20);
    expect(new Set(ACHIEVEMENTS.map((a) => a.group))).toEqual(new Set(["firsts", "teamwork", "pushes", "lifetime"]));
  });
});

describe("referee: drops", () => {
  it("a player's drop counts only against a real request; phone and full aim come from the request", () => {
    const r = table();
    expect(r.frame([{ k: "drop", by: "a" }], 100)).toEqual([]); // host made it up
    const c = drop(r, "a", 500, { phone: true });
    expect(ids(c, "a")).toEqual(["first_drop"]);
    expect(c[0].delta.add).toEqual({ drops: 1, phoneDrops: 1 });
    // A stale request (host sat on it) doesn't count later.
    r.request("b", { t: "drop" }, false, 1000);
    expect(r.frame([{ k: "drop", by: "b" }], 5000)).toEqual([]);
  });

  it("the host's own drops are capped by game time", () => {
    const r = table();
    let n = 0;
    for (let i = 0; i < 20; i++) n += drop(r, "h", 1000).length; // 20 claimed in the first second
    expect(n).toBeLessThanOrEqual(Math.floor(1000 / 350) + 2);
  });

  it("nobody drops more coins than they had", () => {
    const r = new Referee();
    r.hostId = "h";
    r.state(playing(["h", "a"], "g", 20), 0);
    let n = 0;
    for (let i = 0; i < 30; i++) n += drop(r, "a", 1000 + i * 400).length;
    expect(n).toBe(20);
  });
});

describe("referee: coins won", () => {
  it("Into the Tray and Breaking Even go to the lane's player; Bank Shot needs a real full-aim drop", () => {
    const r = new Referee();
    r.hostId = "h";
    r.state(playing(["h", "a"], "g", 20), 0);
    drop(r, "a", 100, { aim: 0.1 });
    // The host claims a's coin was a full-aim bank shot, but a's request wasn't full aim.
    expect(ids(r.frame([{ k: "won", x: 0.1, lane: 1, by: "a", aim: FULL_AIM + 0.01 }], 200), "a")).not.toContain("bank_shot");
    drop(r, "a", 600, { aim: -FULL_AIM - 0.01 });
    const won = r.frame([{ k: "won", x: 0.1, lane: 1, by: "a", aim: -FULL_AIM - 0.01 }], 700);
    expect(ids(won, "a")).toEqual(expect.arrayContaining(["into_the_tray", "bank_shot"]));
    let all: Credit[] = [];
    for (let i = 0; i < 20; i++) all = all.concat(r.frame([{ k: "won", x: 0.1, lane: 1 }], 2000 + i * 200));
    expect(ids(all, "a")).toContain("breaking_even");
  });

  it("Jackpot and Avalanche go to everyone who's dropped; more than the cabinet can do a second is ignored", () => {
    const r = table(["h", "a", "b"]);
    drop(r, "a", 100);
    drop(r, "b", 100);
    const burst = r.frame(Array.from({ length: 12 }, () => ({ k: "won" as const, x: 0, lane: 0 })), 1000);
    expect(ids(burst, "a")).toContain("jackpot");
    expect(ids(burst, "b")).toContain("jackpot");
    expect(ids(burst, "h")).toEqual([]); // the host hasn't dropped: not playing
    const flood = r.frame(Array.from({ length: 100 }, () => ({ k: "won" as const, x: 0, lane: 1 })), 1100);
    expect(flood.filter((c) => c.playerId === "a" && c.earned.includes("into_the_tray")).length).toBeLessThanOrEqual(WON_PER_SECOND_CAP);
    const later = r.frame(Array.from({ length: 13 }, () => ({ k: "won" as const, x: 0, lane: 1 })), 2050);
    expect(ids(later, "a")).toContain("avalanche");
  });
});

describe("referee: prizes", () => {
  it("points come from the tier, each tier once per tower, towers no faster than the cabinet", () => {
    const r = table(["h", "a"]);
    drop(r, "a", 100);
    const p = r.frame([
      { k: "prize", x: 0, tier: 3, points: 999 },
      { k: "prize", x: 0, tier: 3, points: 999 }, // the same box twice
      { k: "prize", x: 0, tier: 2, points: 30 },
      { k: "prize", x: 0, tier: 1, points: 20 },
    ], 200);
    expect(ids(p, "a")).toEqual(expect.arrayContaining(["prize_winner", "top_prize", "high_score"]));
    expect(ids(p, "a")).not.toContain("tower_down");
    expect(p.filter((c) => c.playerId === "a").length).toBe(3);
    const down = r.frame([{ k: "prize", x: 0, tier: 0, points: 10 }], 300);
    expect(ids(down, "a")).toContain("tower_down");
    // A new tower straight away is made up: its boxes don't count.
    expect(r.frame([{ k: "tower" }, { k: "prize", x: 0, tier: 3, points: 50 }], 400)).toEqual([]);
    // A real one, later, does — and the team reaches 250 over two towers.
    // 110 a tower: 250 takes a third.
    const full = (t: number) => r.frame([{ k: "tower" }, ...[3, 2, 1, 0].map((tier) => ({ k: "prize" as const, x: 0, tier, points: 0 }))], t);
    expect(ids(full(6000), "a")).not.toContain("big_night");
    expect(ids(full(12000), "a")).toContain("big_night");
  });
});

describe("referee: shakes and tilt", () => {
  it("only players who really shook count; In Sync, Full Shake, Tilt!", () => {
    const r = table(["h", "a", "b", "c"]);
    for (const id of ["h", "a", "b", "c"]) drop(r, id, 100);
    // b and c never sent a shake: the host can't add them.
    r.request("a", { t: "shake" }, false, 1000);
    const lone = r.frame([{ k: "shake", by: ["a", "b", "c"], strength: 3 }], 1100);
    expect(ids(lone, "a")).toEqual([]);
    for (const id of ["a", "b", "c"]) r.request(id, { t: "shake" }, false, 2000);
    const all4 = r.frame([{ k: "shake", by: ["h", "a", "b", "c"], strength: 3 }], 2100);
    for (const id of ["h", "a", "b", "c"]) expect(ids(all4, id)).toEqual(["in_sync", "full_shake"]);
    expect(ids(r.frame([{ k: "tilt" }], 2200), "b")).toEqual(["tilt"]);
  });

  it("a tilt with no shakes behind it credits nobody, but still spoils Steady Hands", () => {
    const r = table(["h", "a"]);
    drop(r, "h", 1000);
    for (let i = 0; i < 5; i++) drop(r, "a", 1000 + i * 400);
    expect(r.frame([{ k: "tilt" }], 4000)).toEqual([]);
    const end = r.state({ ...playing(["h", "a"]), phase: "over" }, MIN_GAME_MS + 1);
    expect(ids(end, "a")).not.toContain("steady_hands");
  });
});

describe("referee: game end", () => {
  it("counts a real game: games +1, Steady Hands, signed-in partners", () => {
    const r = table(["h", "a", "b"]);
    r.accounts = new Map([["a", "11"], ["b", "22"]]);
    drop(r, "h", 1000);
    for (let i = 0; i < 4; i++) drop(r, "a", 1000 + i * 400);
    drop(r, "b", 1000);
    const end = r.state({ ...playing(["h", "a", "b"]), phase: "over" }, MIN_GAME_MS + 1);
    const a = end.find((c) => c.playerId === "a")!;
    expect(a.earned).toEqual(["steady_hands"]);
    expect(a.delta).toEqual({ add: { games: 1 }, union: { partners: ["22"] } });
    expect(end.find((c) => c.playerId === "h")!.delta.union).toEqual({ partners: ["11", "22"] });
    expect(r.state({ ...playing(["h", "a", "b"]), phase: "over" }, MIN_GAME_MS + 2)).toEqual([]); // once
  });

  it("a game that's too short or has too few drops doesn't count", () => {
    const r = table(["h", "a"]);
    drop(r, "a", 100);
    expect(r.state({ ...playing(["h", "a"]), phase: "over" }, MIN_GAME_MS + 1)).toEqual([]);
  });
});

describe("referee: the caps hold across game ids", () => {
  /** The host announces a new game id, as often as it likes. */
  const restart = (r: Referee, order: string[], n: number, t: number, coinsEach = 20) => r.state(playing(order, `g${n}`, coinsEach), t);

  it("a new game id does not give the host more drops: they are capped by the time games have run", () => {
    const r = new Referee();
    r.hostId = "h";
    let counted = 0;
    // Ten game ids inside one second, the host claiming five drops in each.
    for (let n = 0; n < 10; n++) {
      restart(r, ["h", "a"], n, n * 100);
      for (let i = 0; i < 5; i++) counted += drop(r, "h", n * 100 + 50).length;
    }
    expect(counted).toBeLessThanOrEqual(Math.floor(1000 / 350) + 2);
  });

  it("time between games does not add to the host's allowance; time in games does", () => {
    const r = new Referee();
    r.hostId = "h";
    restart(r, ["h", "a"], 1, 0);
    expect(drop(r, "h", 10)).toHaveLength(1);
    expect(drop(r, "h", 20)).toHaveLength(1);
    expect(drop(r, "h", 30)).toHaveLength(0);
    r.state({ ...playing(["h", "a"], "g1", 20), phase: "over" }, 700); // 700 ms played: two more
    // An hour in the lobby, then a new game.
    restart(r, ["h", "a"], 2, 3_600_000);
    let n = 0;
    for (let i = 0; i < 10; i++) n += drop(r, "h", 3_600_000 + 10).length;
    expect(n).toBe(2);
  });

  it("a new game id does not refill a player's coins while the last shelf is still new", () => {
    const r = new Referee();
    r.hostId = "h";
    restart(r, ["h", "a"], 0, 0);
    let drops = 0;
    // A new id every 2 seconds for 14 seconds; a keeps asking for five more coins each time.
    for (let n = 0; n < 7; n++) {
      if (n) restart(r, ["h", "a"], n, n * 2000);
      for (let i = 0; i < 5; i++) drops += drop(r, "a", n * 2000 + 100 + i * 360).length;
    }
    expect(drops).toBe(20); // what a started with; 35 were asked for
    restart(r, ["h", "a"], 7, 14_500);
    expect(drop(r, "a", 14_900)).toHaveLength(0);
    // A game started once the shelf has had its time is a new shelf, with its coins.
    restart(r, ["h", "a"], 8, MIN_GAME_MS);
    expect(drop(r, "a", MIN_GAME_MS + 100)).toHaveLength(1);
  });

  it("coins won stay within one shelf and one second's worth, however many game ids pass", () => {
    const r = new Referee();
    r.hostId = "h";
    restart(r, ["h", "a"], 0, 0);
    drop(r, "a", 100);
    let credited = 0;
    // 50 game ids in 5 seconds, each paying 40 coins into a's lane at once.
    for (let n = 1; n <= 50; n++) {
      const t = n * 100;
      restart(r, ["h", "a"], n, t);
      credited += r.frame(Array.from({ length: 40 }, () => ({ k: "won" as const, x: 0, lane: 1 })), t).filter((c) => c.earned.includes("into_the_tray")).length;
    }
    expect(credited).toBeLessThanOrEqual(WON_PER_SECOND_CAP * 6);
    // And never more than that one shelf held: the start pile, its stacks, and the one counted drop.
    for (let i = 0; i < 400; i++) credited += r.frame([{ k: "won", x: 0, lane: 1 }], 6_000 + i * 40).filter((c) => c.earned.includes("into_the_tray")).length;
    expect(credited).toBe(190 + 4 * 5 + 1);
  });

  it("a new game id does not bring a new tower: each prize tier still counts once, and towers keep their pace", () => {
    const r = new Referee();
    r.hostId = "h";
    restart(r, ["h", "a"], 0, 0);
    drop(r, "a", 100);
    const tiers = [3, 2, 1, 0].map((tier) => ({ k: "prize" as const, x: 0, tier, points: 0 }));
    let prizes = r.frame(tiers, 200).filter((c) => c.playerId === "a").length;
    expect(prizes).toBe(4);
    for (let n = 1; n <= 20; n++) {
      restart(r, ["h", "a"], n, 200 + n * 100);
      prizes += r.frame([{ k: "tower" }, ...tiers], 250 + n * 100).filter((c) => c.playerId === "a").length;
    }
    expect(prizes).toBe(4);
    // A tower at the cabinet's pace counts as before.
    expect(r.frame([{ k: "tower" }, ...tiers], 6_000).filter((c) => c.playerId === "a")).toHaveLength(4);
  });

  it("a shake still needs each player's own request, and the host's own are spaced, across game ids", () => {
    const r = new Referee();
    r.hostId = "h";
    restart(r, ["h", "a", "b"], 0, 0);
    for (const id of ["h", "a", "b"]) drop(r, id, 100);
    r.request("a", { t: "shake" }, false, 1000);
    r.request("b", { t: "shake" }, false, 1000);
    expect(ids(r.frame([{ k: "shake", by: ["h", "a", "b"], strength: 3 }], 1050), "a")).toEqual(["in_sync"]);
    // New ids, the same proof offered again and again.
    let again = 0;
    for (let n = 1; n <= 5; n++) {
      restart(r, ["h", "a", "b"], n, 1050 + n * 50);
      again += r.frame([{ k: "shake", by: ["h", "a", "b"], strength: 3 }], 1060 + n * 50).length;
    }
    expect(again).toBe(0);
  });

  it("what belongs to one game starts again with each: score, tilt, and whether it counts as a game", () => {
    const r = new Referee();
    r.hostId = "h";
    r.accounts = new Map([["a", "11"], ["b", "22"]]);
    const order = ["h", "a", "b"];
    restart(r, order, 1, 0);
    for (let i = 0; i < 3; i++) drop(r, "a", 1000 + i * 400);
    for (let i = 0; i < 3; i++) drop(r, "b", 1000 + i * 400);
    r.frame([{ k: "tilt" }], 3000);
    const first = r.state({ ...playing(order, "g1", 20), phase: "over" }, MIN_GAME_MS + 1);
    expect(ids(first, "a")).not.toContain("steady_hands");
    expect(first.find((c) => c.playerId === "a")!.delta.add).toEqual({ games: 1 });

    // The next game, started in the ordinary way: a new shelf, full coins, a clean slate for Steady Hands.
    const t0 = MIN_GAME_MS + 5_000;
    restart(r, order, 2, t0);
    let n = 0;
    for (let i = 0; i < 20; i++) n += drop(r, "a", t0 + 1000 + i * 400).length;
    expect(n).toBe(20);
    drop(r, "b", t0 + 1000);
    const second = r.state({ ...playing(order, "g2", 20), phase: "over" }, t0 + MIN_GAME_MS + 1);
    expect(ids(second, "a")).toContain("steady_hands");

    // A game id that comes and goes at once is not a game.
    restart(r, order, 3, t0 + MIN_GAME_MS + 100);
    expect(r.state({ ...playing(order, "g3", 20), phase: "over" }, t0 + MIN_GAME_MS + 200)).toEqual([]);
  });

  it("the coins each player starts with are one of the listed amounts, whatever the host says", () => {
    const r = new Referee();
    r.hostId = "h";
    r.state(playing(["h", "a"], "g", 1_000_000), 0);
    let n = 0;
    for (let i = 0; i < 80; i++) n += drop(r, "a", 1000 + i * 400).length;
    expect(n).toBe(50);
  });
});

describe("scorekeeper: saving to House Tandem", () => {
  function setup(profile: { earned: string[]; stats: Record<string, unknown> } = { earned: [], stats: {} }) {
    const recorded: { userId: string; game: string; delta: unknown; earned: string[]; loginId: number | null | undefined }[] = [];
    const toasts: { playerId: string; ids: string[] }[] = [];
    const work: Promise<unknown>[] = [];
    const ht = {
      gameProfile: vi.fn(async () => profile),
      recordGame: vi.fn(async (userId: string, game: string, delta: unknown, earned: string[], loginId?: number | null) => {
        recorded.push({ userId, game, delta, earned, loginId });
        return { newlyEarned: earned };
      }),
    };
    const sk = new Scorekeeper({ ht, toast: (playerId, ids) => toasts.push({ playerId, ids }), wait: (p) => work.push(p) });
    return { sk, ht, recorded, toasts, settle: () => Promise.all(work) };
  }

  it("signed-in players are saved under game 'coins' and toasted; guests earn nothing", async () => {
    const { sk, recorded, toasts, settle } = setup();
    sk.seat("h", new Map([["a", "11"]]));
    sk.state(playing(["h", "a", "g"]), 0);
    sk.request("a", { t: "drop", aim: 0 }, true, 100);
    sk.request("g", { t: "drop", aim: 0 }, false, 100);
    sk.frame([{ k: "drop", by: "a" }, { k: "drop", by: "g" }], 150);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ userId: "11", game: "coins", earned: ["first_drop"], delta: { add: { drops: 1, phoneDrops: 1 } } });
    expect(toasts).toEqual([{ playerId: "a", ids: ["first_drop"] }]);
  });

  it("saves under the login the player signed in with; without one (older account service) it passes null", async () => {
    const { sk, recorded, toasts, settle } = setup();
    sk.seat("h", new Map([["a", "11"], ["b", "22"]]), new Map([["a", 5]]));
    sk.state(playing(["h", "a", "b"]), 0);
    sk.request("a", { t: "drop", aim: 0, loginId: 99 } as never, false, 100); // nothing in a message sets it
    sk.request("b", { t: "drop", aim: 0 }, false, 100);
    sk.frame([{ k: "drop", by: "a" }, { k: "drop", by: "b" }], 150);
    await settle();
    expect(recorded.map((r) => [r.userId, r.loginId])).toEqual([
      ["11", 5],
      ["22", null],
    ]);
    expect(toasts.map((t) => t.playerId)).toEqual(["a", "b"]);
  });

  it("a save that failed is retried under the same login; seating without logins still works", async () => {
    const { sk, ht, recorded, settle } = setup();
    ht.recordGame.mockRejectedValueOnce(new Error("down"));
    sk.seat("h", new Map([["a", "11"]]), new Map([["a", 5]]));
    sk.state(playing(["h", "a"]), 0);
    sk.request("a", { t: "drop", aim: 0 }, false, 100);
    sk.frame([{ k: "drop", by: "a" }], 150);
    await settle();
    expect(recorded).toHaveLength(0);
    sk.flushAll(10_000);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ userId: "11", loginId: 5, earned: ["first_drop"] });

    const older = setup();
    older.sk.seat("h", new Map([["a", "11"]]));
    older.sk.state(playing(["h", "a"]), 0);
    older.sk.request("a", { t: "drop", aim: 0 }, false, 100);
    older.sk.frame([{ k: "drop", by: "a" }], 150);
    await older.settle();
    expect(older.recorded[0]).toMatchObject({ userId: "11", loginId: null });
  });

  it("lifetime achievements use the stored stats; saves are spaced out", async () => {
    const { sk, recorded, settle } = setup({ earned: ["first_drop"], stats: { phoneDrops: 24, games: 3 } });
    sk.seat("h", new Map([["a", "11"]]));
    sk.state(playing(["h", "a"]), 0);
    sk.request("a", { t: "drop" }, true, 100);
    sk.frame([{ k: "drop", by: "a" }], 150);
    await settle();
    expect(recorded[0].earned).toEqual(["phone_pusher"]); // 24 stored + 1 now; first_drop already had
    sk.request("a", { t: "drop" }, false, 600);
    sk.frame([{ k: "drop", by: "a" }], 650); // within FLUSH_MS of the last save, nothing new: waits
    await settle();
    expect(recorded).toHaveLength(1);
    sk.frame([], 2300);
    await settle();
    expect(recorded).toHaveLength(2);
    expect(recorded[1].delta).toEqual({ add: { drops: 1 } });
  });

  it("without the account service, nothing is saved", () => {
    const sk = new Scorekeeper({ toast: () => { throw new Error("no"); } });
    sk.seat("h", new Map([["a", "11"]]));
    sk.state(playing(["h", "a"]), 0);
    sk.request("a", { t: "drop" }, false, 100);
    expect(() => sk.frame([{ k: "drop", by: "a" }], 150)).not.toThrow();
  });
});

describe("the host tracks who dropped each coin", () => {
  it("a won coin's event carries its dropper and aim; shelf coins carry nobody", async () => {
    const { HostAuthority } = await import("../src/game/host");
    const { FakeSim } = await import("./fakes");
    const sim = new FakeSim();
    let now = 1000;
    const host = new HostAuthority({ selfId: "h", now: () => now, newId: () => "g", newSeed: () => 1 });
    host.attachSim(sim);
    host.join("h", { name: "H" });
    host.join("a", { name: "A" });
    host.start(20);
    host.drop("a", 0.6, 0.5, 0);
    const coin = 1; // FakeSim hands out ids 1, 2, …
    sim.outs.push({ id: coin, kind: 0, x: 0.05, tray: true }, { id: 9999, kind: 0, x: -0.05, tray: true });
    now += 100;
    const frames = host.tick().filter((m) => m.t === "frame");
    now += 100;
    const all = [...frames, ...host.tick().filter((m) => m.t === "frame")];
    const events = all.flatMap((m) => (m.t === "frame" ? m.f.events : []));
    const won = events.filter((e) => e.k === "won");
    expect(won[0]).toMatchObject({ by: "a", aim: 0.6 });
    expect(won[1]).not.toHaveProperty("by");
    expect(events.find((e) => e.k === "drop")).toMatchObject({ by: "a", aim: 0.6 });
  });
});

describe("only the relay can announce an achievement", () => {
  it("from 'server' it's shown; from a player it's dropped", async () => {
    const { Room } = await import("../src/net/room");
    const { FakeTransport } = await import("./fakes");
    const t = new FakeTransport();
    const room = new Room(t, { id: "a1b2c3d4e5f60718", key: "k", name: "A" });
    const got: [string, string[]][] = [];
    room.on("achievement", (p, ids) => got.push([p, ids]));
    t.events.emit("message", { from: "0123456789abcdef", to: "all", msg: { t: "achievement", playerId: "a1b2c3d4e5f60718", ids: ["big_night"] } });
    t.events.emit("message", { from: "server", to: "all", msg: { t: "achievement", playerId: "a1b2c3d4e5f60718", ids: ["first_drop", 5 as unknown as string] } });
    expect(got).toEqual([["a1b2c3d4e5f60718", ["first_drop"]]]);
  });
});
