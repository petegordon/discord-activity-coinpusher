// House Tandem sign-in: the room ticket names the account, the relay tells the
// host which player is which account, and nobody can claim someone else's.
import { describe, expect, it } from "vitest";
import { HostAuthority } from "../src/game/host";
import { Room } from "../src/net/room";
import { loginIdOf } from "../worker/src/peers";
import { readRoomTicket, roomTicket, TICKET_TTL_MS } from "../worker/src/roomTicket";
import { FakeSim, FakeTransport } from "./fakes";

describe("room tickets name the House Tandem account", () => {
  const room = "d" + "0".repeat(30);

  it("binds the House Tandem user id; a swapped id fails; a ticket with no account is a guest", async () => {
    const t = await roomTicket("s3cret", room, "abcd", "42");
    expect(t).toMatch(/^[0-9]+.42..[0-9a-f]{32}$/);
    expect(await readRoomTicket("s3cret", room, "abcd", t)).toEqual({ ok: true, userId: "42" });
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.", ".43."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "other", t)).ok).toBe(false);
    const guest = await roomTicket("s3cret", room, "abcd");
    expect(await readRoomTicket("s3cret", room, "abcd", guest)).toEqual({ ok: true });
    expect((await readRoomTicket("s3cret", room, "abcd", guest.replace("..", ".42."))).ok).toBe(false); // nor an account added to one
  });

  it("binds the login id too; a swapped, dropped or added login fails", async () => {
    const t = await roomTicket("s3cret", room, "abcd", "42", 7);
    expect(t).toMatch(/^[0-9]+.42.7.[0-9a-f]{32}$/);
    expect(await readRoomTicket("s3cret", room, "abcd", t)).toEqual({ ok: true, userId: "42", loginId: 7 });
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".42.8."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".43.7."))).ok).toBe(false);
    expect((await readRoomTicket("s3cret", room, "abcd", t.replace(".42.7.", ".42.."))).ok).toBe(false);
    const plain = await roomTicket("s3cret", room, "abcd", "42", null, 5_000_000);
    expect(await roomTicket("s3cret", room, "abcd", "42", undefined, 5_000_000)).toBe(plain);
    expect((await readRoomTicket("s3cret", room, "abcd", plain.replace(".42..", ".42.7."), 0)).ok).toBe(false);
  });

  it("a ticket stops working after 12 hours, and its date can't be moved", async () => {
    const issued = 1_700_000_000_000;
    const t = await roomTicket("s3cret", room, "abcd", "42", 7, issued + TICKET_TTL_MS);
    expect(TICKET_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(await readRoomTicket("s3cret", room, "abcd", t, issued)).toEqual({ ok: true, userId: "42", loginId: 7 });
    expect((await readRoomTicket("s3cret", room, "abcd", t, issued + TICKET_TTL_MS - 1000)).ok).toBe(true);
    expect(await readRoomTicket("s3cret", room, "abcd", t, issued + TICKET_TTL_MS)).toEqual({ ok: false, expired: true });
    const exp = Number(t.split(".")[0]);
    const later = t.replace(String(exp), String(exp + 3600));
    expect(await readRoomTicket("s3cret", room, "abcd", later, issued + TICKET_TTL_MS)).toEqual({ ok: false });
    // A ticket issued now runs out 12 hours from now.
    const fresh = await roomTicket("s3cret", room, "abcd");
    expect((await readRoomTicket("s3cret", room, "abcd", fresh)).ok).toBe(true);
    expect((await readRoomTicket("s3cret", room, "abcd", fresh, Date.now() + TICKET_TTL_MS + 1000)).expired).toBe(true);
  });

  it("tickets in the form used before they carried a date are not taken", async () => {
    for (const old of ["0".repeat(32), "42." + "0".repeat(32), "42.7." + "0".repeat(32), "", undefined, 7]) {
      expect(await readRoomTicket("s3cret", room, "abcd", old)).toEqual({ ok: false });
    }
  });

  it("reads a login id only from an integer (an older service sends none)", () => {
    expect(loginIdOf(7)).toBe(7);
    expect(loginIdOf("7")).toBe(7);
    for (const v of [undefined, null, "", "x", "7x", 1.5, -1, Number.NaN, {}, true]) expect(loginIdOf(v)).toBeNull();
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
