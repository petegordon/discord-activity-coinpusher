import { TABLE } from "../game/rules";
import { motionEnv, motionVerdict } from "../platform/capabilities";
import { inDiscord } from "../platform/env";
import { aimFromRoll, flickPower, FULL_SPIN_DEG_S, JerkDetector, MotionReader, rollDeg, RollTracker } from "./motion";

/** "blocked": the browser forbids motion in this frame (Discord); "unavailable": no sensors or permission. */
export type MotionState = "unknown" | "needs-permission" | "active" | "blocked" | "unavailable";

export type Drop = { aim: number; power: number; spin: number; source: "motion" | "pointer" | "key" };

export type ControllerCallbacks = {
  /** The chute's aim in radians, ~15 Hz while it changes. */
  onAim: (aim: number) => void;
  onDrop: (drop: Drop) => void;
  onShake: () => void;
  onHint: (text: string) => void;
  onHoldChange: (holding: boolean) => void;
  onMotionState: (state: MotionState) => void;
};

const AIM_SEND_MS = 66;
/** Pointer drag (px) that turns the chute all the way. */
const DRAG_FULL_PX = 140;
/** Pointer drag upward (px) for a full-power drop. */
const SWIPE_FULL_PX = 220;
/** Read the roll this long before a flick: the flick itself tips the phone. */
const AIM_LEAD_MS = 120;
const KEY_AIM_STEP = 0.1;

type DeviceMotionEventIOS = typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * A player's input on the pad. With device motion: hold the pad, roll your
 * wrist to aim the chute, flick to drop a coin (the twist as you flick spins
 * it); let go and jerk the phone up to shake the shelf. Without motion: hold
 * and drag sideways to aim, release to drop (swipe up for more power).
 * Keyboard: ←/→ aim, Space drops, S shakes.
 */
export class CoinController {
  motion: MotionState = "unknown";
  /** −1..1 of TABLE.maxAim. */
  aim = 0;
  private enabled = false;
  private holding = false;
  private pointerId: number | null = null;
  private start = { x: 0, y: 0, aim: 0 };
  private reader = new MotionReader();
  private jerks = new JerkDetector();
  private roll = new RollTracker();
  private lastAimSent = 0;
  private sentAim = NaN;
  private listening = false;

  constructor(
    private readonly zone: HTMLElement,
    private readonly cb: ControllerCallbacks,
    keys: EventTarget | null = window,
  ) {
    zone.addEventListener("pointerdown", (e) => this.down(e));
    zone.addEventListener("pointermove", (e) => this.move(e));
    zone.addEventListener("pointerup", (e) => this.up(e));
    zone.addEventListener("pointercancel", () => this.endHold());
    zone.addEventListener("contextmenu", (e) => e.preventDefault());
    keys?.addEventListener("keydown", (e) => this.key(e as KeyboardEvent));

    const verdict = motionVerdict(motionEnv(inDiscord));
    if (verdict === "probe") this.listen();
    else this.setMotion(verdict);
  }

  /** No motion here, and none coming: blocked, missing, or denied. */
  get motionOff() {
    return this.motion === "blocked" || this.motion === "unavailable";
  }

  get isHolding() {
    return this.holding;
  }

  /** The chute's aim in radians. */
  get aimRad() {
    return this.aim * TABLE.maxAim;
  }

  /** On while a game is on and the shelf can take coins. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.endHold();
  }

  /** Must be called from a user gesture (iOS). */
  async requestMotionPermission(): Promise<boolean> {
    const req = (DeviceMotionEvent as DeviceMotionEventIOS).requestPermission;
    if (!req) return this.motion === "active";
    try {
      const result = await req.call(DeviceMotionEvent);
      if (result === "granted") {
        this.listen();
        return true;
      }
    } catch {
      // Rejected, or not allowed in this frame.
    }
    this.setMotion("unavailable");
    return false;
  }

  private setMotion(state: MotionState) {
    if (this.motion === state) return;
    this.motion = state;
    this.cb.onMotionState(state);
  }

  private setAim(a: number, force = false) {
    this.aim = Math.max(-1, Math.min(1, a));
    const now = performance.now();
    if (!force && (now - this.lastAimSent < AIM_SEND_MS || Math.abs(this.aim - this.sentAim) < 0.01)) return;
    this.lastAimSent = now;
    this.sentAim = this.aim;
    this.cb.onAim(this.aimRad);
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    // Desktop browsers expose DeviceMotionEvent but never fire it; real sensors report within ~1s.
    const timeout = setTimeout(() => this.motion !== "active" && this.setMotion("unavailable"), 1500);
    window.addEventListener("devicemotion", (e) => {
      this.reader.screenAngle = screen.orientation?.angle ?? 0;
      const s = this.reader.read(e, performance.now());
      if (!s) return;
      if (this.motion !== "active") {
        clearTimeout(timeout);
        this.setMotion("active");
      }
      this.roll.push(s.t, rollDeg(s));
      if (!this.enabled) return;
      if (this.holding) this.setAim(aimFromRoll(this.roll.before(AIM_LEAD_MS / 2)));
      const jerk = this.jerks.push(s, this.holding);
      if (!jerk) return;
      if (jerk.kind === "flick") {
        const aim = aimFromRoll(this.roll.before(AIM_LEAD_MS));
        this.setAim(aim, true);
        const spin = Math.max(-1, Math.min(1, this.roll.rate() / FULL_SPIN_DEG_S));
        if ("vibrate" in navigator) navigator.vibrate(30);
        this.cb.onDrop({ aim: this.aimRad, power: flickPower(jerk.peak), spin, source: "motion" });
      } else {
        if ("vibrate" in navigator) navigator.vibrate([20, 30, 20]);
        this.cb.onShake();
      }
    });
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.holding) return;
    e.preventDefault();
    this.holding = true;
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.jerks.reset();
    this.start = { x: e.clientX, y: e.clientY, aim: this.aim };
    this.cb.onHoldChange(true);
  }

  private move(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId || this.motion === "active") return;
    this.setAim(this.start.aim + (e.clientX - this.start.x) / DRAG_FULL_PX);
  }

  private up(e: PointerEvent) {
    if (!this.holding || e.pointerId !== this.pointerId) return;
    const dy = this.start.y - e.clientY;
    this.endHold();
    if (this.motion === "active") return;
    this.setAim(this.aim, true);
    // A tap or a sideways drag drops at middling power; swiping up throws it further.
    const power = dy > 20 ? Math.min(1, dy / SWIPE_FULL_PX) : 0.45;
    this.cb.onDrop({ aim: this.aimRad, power, spin: 0, source: "pointer" });
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled || e.repeat && e.code === "Space") return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      e.preventDefault();
      this.setAim(this.aim + (e.code === "ArrowLeft" ? -KEY_AIM_STEP : KEY_AIM_STEP), true);
    } else if (e.code === "Space") {
      e.preventDefault();
      this.cb.onDrop({ aim: this.aimRad, power: 0.5, spin: 0, source: "key" });
    } else if (e.code === "KeyS") {
      this.cb.onShake();
    }
  }

  private endHold() {
    if (!this.holding) return;
    this.holding = false;
    if (this.pointerId !== null && this.zone.hasPointerCapture(this.pointerId)) this.zone.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    this.jerks.reset();
    this.cb.onHoldChange(false);
  }
}
