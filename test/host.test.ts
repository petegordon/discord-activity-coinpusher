import { describe, expect, it } from "vitest";
import { FRAME_MS, HostAuthority, sanitizeName } from "../src/game/host";
import { DROP_COOLDOWN_MS, END_QUIET_MS, SOLO_SHAKE, SYNC_SHAKE, SYNC_WINDOW_MS, TILT_LOCK_MS } from "../src/game/rules";
import type { Msg } from "../src/net/protocol";
import { KIND_COIN, KIND_PRIZE } from "../src/sim/frame";
import { FakeSim } from "./fakes";

function setup(players = ["a", "b"]) {
  let now = 1000;
  let id = 0;
  const host = new HostAuthority({ selfId: players[0], now: () => now, newId: () => `g${++id}`, newSeed: () => 42 });
  const sim = new FakeSim();
  host.attachSim(sim);
  for (const p of players) host.join(p, { name: p.toUpperCase() });
  const advance = (ms: number) => {
    const out: Msg[] = [];
    // Tick in small steps, like the room does.
    for (let t = 0; t < ms; t += 16) {
      now += Math.min(16, ms - t);
      out.push(...host.tick());
    }
    return out;
  };
  return { host, sim, advance };
}

const frames = (msgs: Msg[]) => msgs.flatMap((m) => (m.t === "frame" ? [m.f] : []));
const events = (msgs: Msg[]) => frames(msgs).flatMap((f) => f.events);

describe("HostAuthority", () => {
  it("starts a game with a fresh shelf", () => {
    const { host, sim } = setup();
    expect(sim.locked).toBe(true); // the pusher waits in the lobby
    host.start(20);
    expect(host.game).toMatchObject({ phase: "playing", coins: { a: 20, b: 20 } });
    expect(sim.resets.length).toBe(2);
    expect(sim.locked).toBe(false);
  });

  it("drops a coin from the player's own chute, aimed and powered as asked, within limits", () => {
    const { host, sim, advance } = setup();
    host.start(30);
    host.handle("b", { t: "drop", aim: 9, power: 0.8, spin: -5 });
    expect(sim.drops[0]).toMatchObject({ power: 0.8, spin: -1 });
    expect(sim.drops[0].x).toBeGreaterThan(0); // b's chute is on the right
    expect(sim.drops[0].aim).toBeCloseTo(Math.PI / 6);
    expect(host.game.coins.b).toBe(29);
    // Too soon, then fine.
    expect(host.handle("b", { t: "drop", aim: 0, power: 0.5, spin: 0 })).toEqual([]);
    advance(DROP_COOLDOWN_MS);
    expect(host.handle("b", { t: "drop", aim: 0, power: 0.5, spin: 0 })[0].t).toBe("state");
    expect(events(advance(FRAME_MS + 20))).toContainEqual({ k: "drop", by: "b" });
  });

  it("refuses drops before the game, with no coins, and from strangers", () => {
    const { host, sim, advance } = setup(["a"]);
    expect(host.handle("a", { t: "drop", aim: 0, power: 0.5, spin: 0 })).toEqual([]);
    host.start(20);
    expect(host.handle("zz", { t: "drop", aim: 0, power: 0.5, spin: 0 })).toEqual([]);
    for (let i = 0; i < 25; i++) {
      host.handle("a", { t: "drop", aim: 0, power: 0.5, spin: 0 });
      advance(DROP_COOLDOWN_MS);
    }
    expect(sim.drops.length).toBe(20);
    expect(host.game.coins.a).toBe(0);
  });

  it("credits what falls off: tray coins to the nearest chute, gutters lost, prizes to the team", () => {
    const { host, sim, advance } = setup();
    host.start(30);
    sim.outs.push({ kind: KIND_COIN, x: -0.15, tray: true }, { kind: KIND_COIN, x: 0.29, tray: false }, { kind: KIND_PRIZE + 3, x: 0, tray: true });
    const out = advance(100);
    expect(host.game.coins).toEqual({ a: 31, b: 30 });
    expect(host.game).toMatchObject({ score: 50, prizes: 1, coinsWon: 1, coinsLost: 1 });
    expect(out.some((m) => m.t === "state")).toBe(true);
    expect(events(out).map((e) => e.k)).toEqual(["won", "lost", "prize"]);
  });

  it("makes shakes from two players inside the window one strong shake", () => {
    const { host, sim, advance } = setup();
    host.start(30);
    host.handle("a", { t: "shake" });
    advance(SYNC_WINDOW_MS - 100);
    host.handle("b", { t: "shake" });
    const out = advance(150);
    expect(sim.shakes).toEqual([SYNC_SHAKE]);
    expect(events(out)).toContainEqual({ k: "shake", by: ["a", "b"], strength: SYNC_SHAKE });
  });

  it("makes a lone shake (with others at the table) a gentle one", () => {
    const { host, sim, advance } = setup();
    host.start(30);
    host.handle("a", { t: "shake" });
    advance(SYNC_WINDOW_MS + 50);
    host.handle("b", { t: "shake" }); // too late to join a's
    advance(SYNC_WINDOW_MS + 50);
    expect(sim.shakes).toEqual([SOLO_SHAKE, SOLO_SHAKE]);
  });

  it("gives a player on their own the strong shake", () => {
    const { host, sim, advance } = setup(["a"]);
    host.start(30);
    host.handle("a", { t: "shake" });
    advance(SYNC_WINDOW_MS + 50);
    expect(sim.shakes).toEqual([SYNC_SHAKE]);
  });

  it("fills the tilt meter with shakes, locks the shelf when it's full, then unlocks", () => {
    const { host, sim, advance } = setup();
    host.start(30);
    host.handle("a", { t: "shake" });
    host.handle("b", { t: "shake" });
    advance(500); // past the shake cooldown
    expect(host.tilt).toBeGreaterThan(45);
    host.handle("a", { t: "shake" });
    host.handle("b", { t: "shake" });
    const out = advance(SYNC_WINDOW_MS + 20);
    expect(events(out)).toContainEqual({ k: "tilt" });
    expect(host.isLocked).toBe(true);
    expect(sim.locked).toBe(true);
    // Locked: no drops, no shakes.
    expect(host.handle("a", { t: "drop", aim: 0, power: 0.5, spin: 0 })).toEqual([]);
    host.handle("a", { t: "shake" });
    const during = advance(TILT_LOCK_MS + 100);
    expect(sim.shakes.length).toBe(2);
    expect(events(during)).toContainEqual({ k: "unlock" });
    expect(host.isLocked).toBe(false);
    expect(sim.locked).toBe(false);
    expect(host.tilt).toBe(0);
  });

  it("drains the tilt meter over time", () => {
    const { host, advance } = setup(["a"]);
    host.start(30);
    host.handle("a", { t: "shake" });
    advance(SYNC_WINDOW_MS + 20);
    const t0 = host.tilt;
    advance(1000);
    expect(host.tilt).toBeLessThan(t0 - 10);
  });

  it("ends the game once everyone is out of coins and nothing comes back for a while", () => {
    const { host, sim, advance } = setup(["a"]);
    host.start(20);
    for (let i = 0; i < 20; i++) {
      host.handle("a", { t: "drop", aim: 0, power: 0.5, spin: 0 });
      advance(DROP_COOLDOWN_MS);
    }
    advance(END_QUIET_MS - 1000);
    // A coin comes back just in time: the game goes on.
    sim.outs.push({ kind: KIND_COIN, x: 0, tray: true });
    advance(1500);
    expect(host.game.phase).toBe("playing");
    host.handle("a", { t: "drop", aim: 0, power: 0.5, spin: 0 });
    advance(END_QUIET_MS + 100);
    expect(host.game.phase).toBe("over");
    expect(sim.locked).toBe(true);
    host.rematch();
    expect(host.game).toMatchObject({ phase: "playing", coins: { a: 20 } });
  });

  it("sends frames ~15 Hz, with a keyframe for anyone who just joined", () => {
    const { host, advance } = setup(["a"]);
    const f1 = frames(advance(1000));
    expect(f1.length).toBeGreaterThanOrEqual(13);
    expect(f1.length).toBeLessThanOrEqual(16);
    expect(f1[0].key).toBe(true);
    expect(f1[1].key).toBe(false);
    host.join("b", { name: "B" });
    expect(frames(advance(FRAME_MS + 20))[0].key).toBe(true);
  });

  it("carries the shelf over to a new host from the last frame", () => {
    const sim = new FakeSim();
    const next = new HostAuthority({ selfId: "b", now: () => 5000 });
    next.attachSim(sim, { bodies: [{ id: 3, kind: 0, p: [0, 0, 0], q: [0, 0, 0, 1] }], time: 12, tilt: 40, locked: 2000 });
    expect(sim.restored?.length).toBe(1);
    expect(sim.resets).toEqual([]);
    expect(next.tilt).toBe(40);
    expect(next.isLocked).toBe(true);
  });

  it("cleans up names", () => {
    expect(sanitizeName("  Ann\u0000ie  ")).toBe("Annie");
    expect(sanitizeName("")).toBe("Player");
    expect(sanitizeName("x".repeat(40))).toHaveLength(24);
  });
});
