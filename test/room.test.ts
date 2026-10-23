import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPlayer, createGame, startGame } from "../src/game/dozer";
import { FakeSim, FakeTransport } from "./fakes";
import type { Envelope, Msg, Target } from "../src/net/protocol";
import { RelayTransport } from "../src/net/relay";
import { RECONNECT_GRACE_MS, Room } from "../src/net/room";
import { packBodies } from "../src/sim/frame";


const self = (id: string) => ({ id, key: "k", name: id.toUpperCase() });

function hostRoom(now: { t: number }) {
  const t = new FakeTransport();
  const room = new Room(t, self("h"), () => now.t);
  room.makeSim = async () => new FakeSim();
  t.events.emit("host-change", true);
  return { t, room };
}

const env = (from: string, msg: Msg, to: Target = "host"): Envelope => ({ from, to, msg });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Room as host", () => {
  it("adds players on hello and broadcasts state", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "Alice" } }));
    expect(room.players.map((p) => p.id)).toEqual(["h", "a"]);
    expect(t.sent.at(-1)?.msg.t).toBe("state");
  });

  it("keeps a briefly disconnected player, and drops one who stays away", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "A" } }));
    t.events.emit("message", env("b", { t: "hello", player: { name: "B" } }));
    t.events.emit("peers", ["h", "a", "b"]);

    t.events.emit("peers", ["h", "b"]); // a drops
    now.t += RECONNECT_GRACE_MS - 1000;
    room.prune();
    expect(room.players.map((p) => p.id)).toContain("a");
    t.events.emit("peers", ["h", "a", "b"]); // a is back
    now.t += 5000;
    room.prune();
    expect(room.players.map((p) => p.id)).toContain("a");

    t.events.emit("peers", ["h", "a"]); // b drops for good
    now.t += RECONNECT_GRACE_MS;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["h", "a"]);
  });

  it("passes on players' aims, clamped, and ignores strangers'", () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    t.events.emit("message", env("a", { t: "hello", player: { name: "A" } }));
    const aims: [string, number][] = [];
    room.on("aim", (p, a) => aims.push([p, a]));
    t.events.emit("message", env("a", { t: "aim", aim: 1e6 }, "all"));
    t.events.emit("message", env("zz", { t: "aim", aim: 0.1 }, "all"));
    expect(aims).toEqual([["a", Math.PI / 6]]);
    room.leave();
  });

  it("runs the shelf and broadcasts frames once the physics is ready", async () => {
    const now = { t: 0 };
    const { t, room } = hostRoom(now);
    await Promise.resolve();
    await Promise.resolve();
    expect(room.host?.simReady).toBe(true);
    now.t += 100;
    vi.advanceTimersByTime(100);
    expect(t.sent.some((s) => s.msg.t === "frame" && s.to === "all")).toBe(true);
    expect(room.lastFrame?.key).toBe(true);
    room.leave();
  });
});

describe("Room host migration", () => {
  it("drops the old host, carries the shelf over, and gives everyone else the grace period", async () => {
    const now = { t: 1000 };
    const t = new FakeTransport();
    const room = new Room(t, self("b"), () => now.t);
    const sim = new FakeSim();
    room.makeSim = async () => sim;
    t.events.emit("host-change", false);
    expect(t.sent[0]).toMatchObject({ msg: { t: "hello" }, to: "host" });

    // Last state from the old host "a": a, b, c in a match.
    let game = ["a", "b", "c"].reduce(addPlayer, createGame());
    game = startGame(game, 30, "g1");
    const players = ["a", "b", "c"].map((id, i) => ({ id, name: id, color: "#fff", joinedAt: i }));
    t.events.emit("message", env("a", { t: "state", players, game, hostId: "a" }, "all"));

    const bodies = packBodies([{ id: 7, kind: 0, p: [0.1, 0.01, 0], q: [0, 0, 0, 1] }]);
    const frame = { seq: 5, ms: 9000, gameId: "g1", pusher: -0.1, tilt: 20, locked: 0, key: true, bodies, gone: [], events: [] };
    t.events.emit("message", env("a", { t: "frame", f: frame }, "all"));
    expect(room.bodies.size).toBe(1);

    t.events.emit("host-change", true);
    expect(room.isHost).toBe(true);
    expect(room.players.map((p) => p.id)).toEqual(["b", "c"]);
    expect(room.game.coins).toMatchObject({ b: 30, c: 30 });
    await Promise.resolve();
    await Promise.resolve();
    // The shelf carries on from the last frame instead of starting over.
    expect(sim.restored?.map((b) => b.id)).toEqual([7]);
    expect(sim.resets).toEqual([]);

    t.events.emit("peers", ["b"]); // c hasn't reconnected yet
    now.t += RECONNECT_GRACE_MS - 1;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["b", "c"]);
    now.t += 2;
    room.prune();
    expect(room.players.map((p) => p.id)).toEqual(["b"]);
    room.leave();
  });
});

describe("RelayTransport", () => {
  class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    constructor(public url: string) {
      FakeSocket.instances.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {}
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    peers(ids: string[]) {
      this.onmessage?.({ data: JSON.stringify({ type: "peers", ids }) });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  it("re-announces itself to an unchanged host after reconnecting", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { href: "https://dozer.example/" });
    const relay = new RelayTransport("ROOM", "b", "key", "/api");
    const changes: boolean[] = [];
    relay.on("host-change", (isHost) => changes.push(isHost));
    const connected = relay.connect();
    const first = FakeSocket.instances.at(-1)!;
    expect(first.url).toContain("key=key");
    first.open();
    first.peers(["a", "b"]);
    await connected;
    expect(changes).toEqual([false]);

    first.peers(["a", "b", "c"]); // same host, same socket: no re-announce
    expect(changes).toEqual([false]);

    first.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.open();
    second.peers(["a", "b"]);
    expect(changes).toEqual([false, false]);
    relay.close();
    vi.unstubAllGlobals();
  });
});
