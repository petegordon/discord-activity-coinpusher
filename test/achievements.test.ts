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

describe("scorekeeper: saving to House Tandem", () => {
  function setup(profile: { earned: string[]; stats: Record<string, unknown> } = { earned: [], stats: {} }) {
    const recorded: { userId: string; game: string; delta: unknown; earned: string[] }[] = [];
    const toasts: { playerId: string; ids: string[] }[] = [];
    const work: Promise<unknown>[] = [];
    const ht = {
      gameProfile: vi.fn(async () => profile),
      recordGame: vi.fn(async (userId: string, game: string, delta: unknown, earned: string[]) => {
        recorded.push({ userId, game, delta, earned });
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
