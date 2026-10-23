import type { GameState } from "../game/dozer";
import type { Frame } from "../sim/frame";

export type Player = {
  id: string;
  name: string;
  avatarUrl?: string;
  color: string;
  joinedAt: number;
  /** Id of the phone paired as this player's controller (see PHONE-REMOTE.md). */
  remoteId?: string;
  /** Whether that phone is connected right now. */
  remoteOnline?: boolean;
};

export type Msg =
  /** peer → host, on (re)connect */
  | { t: "hello"; player: { name: string; avatarUrl?: string } }
  /** host → all, whenever players or the count change */
  | { t: "state"; players: Player[]; game: GameState; hostId: string }
  /** host → all, ~15 Hz: the shelf's physics (src/sim/frame.ts) */
  | { t: "frame"; f: Frame }
  /** player (or their remote) → all, ~15 Hz while aiming: where their chute points (radians). Cosmetic. */
  | { t: "aim"; aim: number }
  /** player (or remote) → host: launch a coin. power 0..1, spin −1..1. */
  | { t: "drop"; aim: number; power: number; spin: number }
  /** player (or remote) → host: a shelf shake */
  | { t: "shake" }
  /** player → host: make this remote id my phone remote, replacing any other */
  | { t: "pair"; remoteId: string }
  /** player → host: forget my phone remote */
  | { t: "unpair" }
  /** remote → host, on (re)connect: please send the current state */
  | { t: "remote-hello" };

export type Target = "host" | "all";

/**
 * `remote` is set by the relay or the PeerJS host when the sender connected
 * as a phone remote. It is never taken from the sender.
 */
export type Envelope = { from: string; to: Target; msg: Msg; remote?: boolean };

/** The only message type a non-host may broadcast; transports drop the rest. */
export const CLIENT_BROADCASTS: ReadonlySet<string> = new Set(["aim"]);

/** Cosmetic broadcasts that transports rate-limit per sender. */
export const THROTTLED = "aim";

const MSG_TYPES = new Set(["hello", "state", "frame", "aim", "drop", "shake", "pair", "unpair", "remote-hello"]);

export type Role = "player" | "remote";

/** Light structural validation for anything arriving off the wire. */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const msg = v.msg as Record<string, unknown> | undefined;
  return (
    typeof v.from === "string" &&
    (v.to === "host" || v.to === "all") &&
    !!msg &&
    typeof msg === "object" &&
    typeof msg.t === "string" &&
    MSG_TYPES.has(msg.t)
  );
}
