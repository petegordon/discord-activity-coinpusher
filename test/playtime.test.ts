// Time in game (housetandem-web #37): the relay credits the socket's verified account; the client counts active time.
import { describe, expect, it, vi } from "vitest";
import { createPlaytime } from "../src/platform/playtime";
import type { Attachment } from "../worker/src/peers";
import { MAX_PLAYTIME_S, PLAYTIME_GAME, PLAYTIME_MIN_INTERVAL_MS, recordPlaytime } from "../worker/src/playtime";

const signedIn: Attachment = { id: "a".repeat(16), joinedAt: 1, role: "player", userId: "42" };
const guest: Attachment = { id: "b".repeat(16), joinedAt: 2, role: "player" };

function fakeHt(impl?: () => Promise<unknown>) {
  return { recordPlay: vi.fn(impl ?? (async () => ({ seconds: 60, sessions: 1, added: 60 }))) };
}

describe("relay: playtime reports", () => {
  it("credits the socket's verified account, with the seconds clamped", () => {
    const ht = fakeHt();
    const wait = vi.fn();
    const att = recordPlaytime(ht, signedIn, { s: 61.4 }, 10_000, wait);
    expect(ht.recordPlay).toHaveBeenCalledWith("42", PLAYTIME_GAME, 61);
    expect(PLAYTIME_GAME).toBe("coins");
    expect(wait).toHaveBeenCalledOnce();
    expect(att).toEqual({ ...signedIn, lastPlaytime: 10_000 });

    recordPlaytime(ht, signedIn, { s: 99_999 }, 20_000);
    expect(ht.recordPlay).toHaveBeenLastCalledWith("42", "coins", MAX_PLAYTIME_S);
    recordPlaytime(ht, signedIn, { s: -5 }, 30_000);
    expect(ht.recordPlay).toHaveBeenLastCalledWith("42", "coins", 1);
  });

  it("ignores any user id in the message", () => {
    const ht = fakeHt();
    recordPlaytime(ht, signedIn, { s: 30, userId: "7" } as { s: number }, 10_000);
    expect(ht.recordPlay).toHaveBeenCalledWith("42", "coins", 30);
  });

  it("doesn't count guests, phone remotes, junk, or a room without the account service", () => {
    const ht = fakeHt();
    expect(recordPlaytime(ht, guest, { s: 60 }, 10_000)).toBeNull();
    expect(recordPlaytime(ht, { ...signedIn, role: "remote" }, { s: 60 }, 10_000)).toBeNull();
    expect(recordPlaytime(ht, signedIn, { s: "60" }, 10_000)).toBeNull();
    expect(recordPlaytime(ht, signedIn, { s: Number.NaN }, 10_000)).toBeNull();
    expect(recordPlaytime(ht, signedIn, {}, 10_000)).toBeNull();
    expect(recordPlaytime(undefined, signedIn, { s: 60 }, 10_000)).toBeNull();
    expect(ht.recordPlay).not.toHaveBeenCalled();
  });

  it("takes at most one report per socket per interval", () => {
    const ht = fakeHt();
    const att = recordPlaytime(ht, signedIn, { s: 60 }, 10_000)!;
    expect(recordPlaytime(ht, att, { s: 60 }, 10_000 + PLAYTIME_MIN_INTERVAL_MS - 1)).toBeNull();
    expect(recordPlaytime(ht, att, { s: 60 }, 10_000 + PLAYTIME_MIN_INTERVAL_MS)).not.toBeNull();
    expect(ht.recordPlay).toHaveBeenCalledTimes(2);
  });

  it("survives the account service rejecting or throwing (e.g. not deployed yet)", async () => {
    const log = vi.fn();
    const waited: Promise<unknown>[] = [];
    const rejecting = fakeHt(() => Promise.reject(new Error("no such method recordPlay")));
    expect(() => recordPlaytime(rejecting, signedIn, { s: 60 }, 10_000, (p) => waited.push(p), log)).not.toThrow();
    await Promise.all(waited);
    expect(log).toHaveBeenCalledWith("recordPlay failed", expect.any(Error));

    const throwing = {
      recordPlay: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    expect(() => recordPlaytime(throwing, signedIn, { s: 60 }, 10_000, undefined, log)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("client: createPlaytime (port of Tandemonium js/playtime.js)", () => {
  function setup(opts: { signedIn?: boolean; idleMs?: number; send?: (s: number) => boolean } = {}) {
    let t = 0;
    const doc = { visibilityState: "visible" };
    const sent: number[] = [];
    const pt = createPlaytime({
      game: "coins",
      send: opts.send ?? ((s) => (sent.push(s), true)),
      signedIn: () => opts.signedIn ?? true,
      idleMs: opts.idleMs,
      now: () => t,
      doc,
      win: {},
    });
    const advance = (ms: number) => {
      for (let i = 0; i < ms / 5000; i++) {
        t += 5000;
        pt._tick();
      }
    };
    return { pt, sent, doc, advance };
  }

  it("reports whole-second deltas about once a minute", () => {
    const { pt, sent, advance } = setup();
    advance(60_000);
    expect(sent).toEqual([60]);
    advance(60_000);
    expect(sent).toEqual([60, 60]);
    expect(pt.pending).toBe(0);
  });

  it("counts nothing signed out, hidden, or idle", () => {
    const out = setup({ signedIn: false });
    out.advance(120_000);
    expect(out.sent).toEqual([]);

    const hidden = setup();
    hidden.doc.visibilityState = "hidden";
    hidden.advance(120_000);
    expect(hidden.sent).toEqual([]);

    const idle = setup({ idleMs: 30_000 });
    idle.advance(120_000);
    expect(idle.sent).toEqual([30]);
    idle.pt.noteActivity();
    idle.advance(60_000);
    expect(idle.sent.reduce((a, b) => a + b, 0) + idle.pt.pending).toBe(60);
  });

  it("keeps the seconds when the socket isn't open", () => {
    let open = false;
    const sent: number[] = [];
    const { pt, advance } = setup({ send: (s) => (open ? (sent.push(s), true) : false) });
    advance(60_000);
    expect(sent).toEqual([]);
    expect(pt.pending).toBe(60);
    open = true;
    advance(60_000);
    expect(sent).toEqual([120]);
  });
});
