// House Tandem sign-in: the room ticket names the account, the relay tells the
// host which player is which account, and nobody can claim someone else's.
import { describe, expect, it } from "vitest";
import { HostAuthority } from "../src/game/host";
import { Room } from "../src/net/room";
import { readRoomTicket, roomTicket } from "../worker/src/roomTicket";
import { FakeSim, FakeTransport } from "./fakes";

describe("room tickets name the House Tandem account", () => {
  it("a signed-in ticket carries the account; a bare one admits a guest; a swapped id fails", async () => {
    const t = await roomTicket("secret", "dabc", "p1", "42");
    expect(t).toMatch(/^42\.[0-9a-f]{32}$/);
    expect(await readRoomTicket("secret", "dabc", "p1", t)).toEqual({ ok: true, userId: "42" });
    expect(await readRoomTicket("secret", "dabc", "p1", t.replace(/^42/, "43"))).toEqual({ ok: false });
    expect(await readRoomTicket("secret", "dabc", "p2", t)).toEqual({ ok: false });
    const guest = await roomTicket("secret", "dabc", "p1");
    expect(await readRoomTicket("secret", "dabc", "p1", guest)).toEqual({ ok: true });
    expect(await readRoomTicket("secret", "dabc", "p1", "nope")).toEqual({ ok: false });
  });
});

describe("the host learns accounts from the relay only", () => {
  it("sets accountId from the peers map, keeps it for late joiners, and clears it on sign-out", () => {
    const host = new HostAuthority({ selfId: "a", now: () => 0, newId: () => "g", newSeed: () => 1 });
    host.attachSim(new FakeSim());
    host.join("a", { name: "A" });
    expect(host.setAccounts({ a: "7", b: "9" })[0]?.t).toBe("state");
    expect(host.players[0].accountId).toBe("7");
    host.join("b", { name: "B" });
    expect(host.players[1].accountId).toBe("9");
    expect(host.setAccounts({ a: "7", b: "9" })).toEqual([]); // nothing changed, nothing sent
    host.setAccounts({ a: "7" });
    expect(host.players[1].accountId).toBeUndefined();
    // A hello can't set it.
    host.join("c", { name: "C", accountId: "1" } as never);
    expect(host.players[2].accountId).toBeUndefined();
  });

  it("the room passes the relay's map to the host and broadcasts it in state", async () => {
    const t = new FakeTransport();
    const room = new Room(t, { id: "h", key: "k", name: "H" }, () => 0);
    room.makeSim = async () => new FakeSim();
    t.events.emit("host-change", true);
    t.events.emit("peers", ["h"], { h: "42" });
    expect(room.players.find((p) => p.id === "h")?.accountId).toBe("42");
    const last = t.sent.filter((s) => s.msg.t === "state").at(-1)?.msg as { players: { accountId?: string }[] } | undefined;
    expect(last?.players[0].accountId).toBe("42");
  });
});
