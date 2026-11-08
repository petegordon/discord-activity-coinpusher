import type { Attachment } from "./peers";

/** House Tandem game id (also in scorekeeper.ts). */
export const PLAYTIME_GAME = "coins";
/** The account service takes at most 10 minutes per report. */
export const MAX_PLAYTIME_S = 600;
/** One report per socket at most this often; clients send about once a minute. */
export const PLAYTIME_MIN_INTERVAL_MS = 2_000;

/** The account service's time-in-game call (Tandemonium's HouseTandemGames entrypoint, housetandem-web #37). */
export type PlaytimeService = {
  recordPlay(userId: string, game: string, seconds: number): Promise<unknown>;
};

/**
 * A `{ to: "server", msg: { t: "playtime", s } }` from a socket: credit `s`
 * active seconds (a delta since that client's last report) to the socket's
 * VERIFIED House Tandem account. The account comes from the attachment the
 * Worker set from the Discord ticket / web session, never from the message.
 * Guests and phone remotes aren't counted. The server caps each delta to real
 * time, so a lying client can't add more than the time it's actually been here.
 *
 * Returns the attachment to save (with the report time), or null when nothing
 * was sent. Never throws; RPC failures are logged and dropped.
 */
export function recordPlaytime(
  ht: PlaytimeService | undefined,
  sender: Attachment,
  msg: { s?: unknown },
  now: number,
  wait?: (p: Promise<unknown>) => void,
  log?: (...args: unknown[]) => void,
): Attachment | null {
  if (!ht || !sender.userId || sender.role === "remote") return null;
  if (typeof msg.s !== "number" || !Number.isFinite(msg.s)) return null;
  if (now - (sender.lastPlaytime ?? -Infinity) < PLAYTIME_MIN_INTERVAL_MS) return null;
  const seconds = Math.min(MAX_PLAYTIME_S, Math.max(1, Math.round(msg.s)));
  let work: Promise<unknown>;
  try {
    work = Promise.resolve(ht.recordPlay(sender.userId, PLAYTIME_GAME, seconds)).catch((e) => log?.("recordPlay failed", e));
  } catch (e) {
    log?.("recordPlay failed", e);
    work = Promise.resolve();
  }
  wait?.(work);
  return { ...sender, lastPlaytime: now };
}
