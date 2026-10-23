/** One devicemotion reading in the device frame (m/s², deg/s). */
export type MotionSample = {
  /** ms */
  t: number;
  /** Acceleration with gravity removed. */
  ax: number;
  ay: number;
  az: number;
  /** Smoothed gravity reaction (points up, ~9.8 long), in the same frame. */
  gx: number;
  gy: number;
  gz: number;
};

/** A jerk at least this hard (m/s², ~1.3 g) while holding the pad drops a coin. */
export const FLICK_PEAK = 13;
/** A flick this hard (or harder) is full power. */
export const FLICK_FULL = 30;
/** An upward jerk at least this hard, with the pad released, shakes the shelf. */
export const SHAKE_PEAK = 12;
/** …and at least this much of it must point up. */
const SHAKE_UPNESS = 0.6;
/** After a spike, keep reading this long to find its peak. */
const PEAK_MS = 80;
/** Ignore further jerks this long after one counts (the hand's recoil). */
const REFRACTORY_MS = 300;
/** Wrist roll that turns the chute all the way (degrees). */
export const FULL_ROLL_DEG = 35;
/** Roll rate (deg/s) that counts as full spin. */
export const FULL_SPIN_DEG_S = 300;

/**
 * Converts a DeviceMotionEvent into a sample, keeping a smoothed gravity
 * estimate. Some browsers (iOS Safari, at least historically) report every
 * axis with the opposite sign from the spec; held the usual way, gravity per
 * the spec reads up the screen (+y) and out of it (+z), so if it reads the
 * other way every axis is negated.
 */
export class MotionReader {
  /** +1 for spec axes, −1 for inverted ones. */
  sign = 1;
  /** screen.orientation.angle, kept current by the controller. */
  screenAngle = 0;
  private g: [number, number, number] | null = null;

  read(e: DeviceMotionEvent, t: number): MotionSample | null {
    const gi = e.accelerationIncludingGravity;
    if (!gi || gi.x === null || gi.y === null || gi.z === null) return null;
    const raw: [number, number, number] = [gi.x, gi.y, gi.z];
    // Light smoothing: follows a wrist roll in ~100 ms, but a flick barely moves it.
    this.g = this.g ? (this.g.map((v, i) => 0.82 * v + 0.18 * raw[i]) as [number, number, number]) : raw;
    const [gx, gy, gz] = this.g;
    const rad = (this.screenAngle * Math.PI) / 180;
    const up = gx * Math.sin(rad) + gy * Math.cos(rad);
    if (Math.abs(up + gz) >= 5) this.sign = up + gz > 0 ? 1 : -1;
    const k = this.sign;
    const a = e.acceleration;
    const lin =
      a && a.x !== null && a.y !== null && a.z !== null ? [a.x, a.y, a.z] : [raw[0] - gx, raw[1] - gy, raw[2] - gz];
    return { t, ax: k * lin[0], ay: k * lin[1], az: k * lin[2], gx: k * gx, gy: k * gy, gz: k * gz };
  }
}

/**
 * How far the wrist is rolled, in degrees: positive when the phone's right
 * edge dips. Read from gravity across the phone's short (x) axis, so it works
 * held flat and pointing forward, or upright like a steering wheel.
 */
export function rollDeg(s: Pick<MotionSample, "gx" | "gy" | "gz">): number {
  const g = Math.hypot(s.gx, s.gy, s.gz);
  if (g < 3) return 0;
  return (Math.asin(Math.max(-1, Math.min(1, -s.gx / g))) * 180) / Math.PI;
}

/** −1..1: the chute's turn for a roll. */
export function aimFromRoll(deg: number): number {
  return Math.max(-1, Math.min(1, deg / FULL_ROLL_DEG));
}

export type Jerk = { kind: "flick" | "shake"; peak: number; t: number };

/**
 * Spots the two gestures. While the pad is held, any sharp jerk is a flick
 * (drop a coin). With it released, a sharp jerk that points up is a shake.
 */
export class JerkDetector {
  private spike: { start: number; peak: number; up: number; holding: boolean } | null = null;
  private quietUntil = 0;

  reset() {
    this.spike = null;
  }

  push(s: MotionSample, holding: boolean): Jerk | null {
    const m = Math.hypot(s.ax, s.ay, s.az);
    const g = Math.hypot(s.gx, s.gy, s.gz) || 1;
    const up = (s.ax * s.gx + s.ay * s.gy + s.az * s.gz) / g;
    if (!this.spike) {
      if (s.t < this.quietUntil) return null;
      const threshold = holding ? FLICK_PEAK : SHAKE_PEAK;
      if (m >= threshold * 0.75) this.spike = { start: s.t, peak: m, up, holding };
      return null;
    }
    if (m > this.spike.peak) {
      this.spike.peak = m;
      this.spike.up = up;
    }
    if (s.t - this.spike.start < PEAK_MS) return null;
    const { peak, holding: held } = this.spike;
    const upness = this.spike.up / (peak || 1);
    this.spike = null;
    if (held && peak >= FLICK_PEAK) {
      this.quietUntil = s.t + REFRACTORY_MS;
      return { kind: "flick", peak, t: s.t };
    }
    if (!held && peak >= SHAKE_PEAK && upness >= SHAKE_UPNESS) {
      this.quietUntil = s.t + REFRACTORY_MS;
      return { kind: "shake", peak, t: s.t };
    }
    return null;
  }
}

/** 0..1 from a flick's peak. */
export function flickPower(peak: number): number {
  return Math.max(0, Math.min(1, (peak - FLICK_PEAK) / (FLICK_FULL - FLICK_PEAK)));
}

/**
 * The wrist's roll and how fast it's turning, from successive samples.
 * `at(t)` gives the roll a moment before `t`, since the flick itself tips
 * the phone: the coin goes where you were aiming, not where the flick ended.
 */
export class RollTracker {
  private hist: { t: number; roll: number }[] = [];

  push(t: number, roll: number) {
    this.hist.push({ t, roll });
    while (this.hist.length > 2 && t - this.hist[0].t > 600) this.hist.shift();
  }

  reset() {
    this.hist = [];
  }

  get roll(): number {
    return this.hist.at(-1)?.roll ?? 0;
  }

  /** Roll as of `ms` before the latest sample. */
  before(ms: number): number {
    const last = this.hist.at(-1);
    if (!last) return 0;
    for (let i = this.hist.length - 1; i >= 0; i--) if (last.t - this.hist[i].t >= ms) return this.hist[i].roll;
    return this.hist[0].roll;
  }

  /** deg/s over the `ms` before `endMsAgo` ms ago. */
  rate(ms = 150, endMsAgo = 80): number {
    const last = this.hist.at(-1);
    if (!last) return 0;
    const lastWhere = (ok: (h: { t: number; roll: number }) => boolean) => {
      for (let i = this.hist.length - 1; i >= 0; i--) if (ok(this.hist[i])) return this.hist[i];
      return this.hist[0];
    };
    const end = lastWhere((h) => last.t - h.t >= endMsAgo);
    const start = lastWhere((h) => end.t - h.t >= ms);
    const dt = (end.t - start.t) / 1000;
    return dt > 0.02 ? (end.roll - start.roll) / dt : 0;
  }
}
