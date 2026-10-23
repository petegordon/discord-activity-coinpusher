const MUTE_KEY = "dozer.muted";

/**
 * Synthesised arcade sounds (no audio files): coin clinks, the jackpot
 * cascade into the tray, a prize fanfare, the shelf's thump, and the tilt alarm.
 */
export class CoinAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private lastClink = 0;
  muted: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MUTE_KEY);
    } catch {
      // storage unavailable
    }
    this.muted = stored === "1";
  }

  /** Call from a user gesture; browsers keep audio suspended until then. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // storage unavailable
    }
  }

  private get live(): AudioContext | null {
    return this.ctx && !this.muted ? this.ctx : null;
  }

  private tone(freq: number, at: number, dur: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.live;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private thud(at: number, dur: number, gain: number, cutoff: number) {
    const ctx = this.live;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  /** A metal coin ringing. `level` 0..1. */
  clink(level = 0.6, at = this.ctx?.currentTime ?? 0) {
    const nowMs = performance.now();
    if (at === (this.ctx?.currentTime ?? 0) && nowMs - this.lastClink < 30) return;
    this.lastClink = nowMs;
    const base = 2600 + Math.random() * 900;
    this.tone(base, at, 0.18, 0.08 * level);
    this.tone(base * 2.76, at, 0.09, 0.04 * level);
    this.tone(base * 0.51, at, 0.06, 0.03 * level, "triangle");
  }

  /** A coin into the chute. */
  drop() {
    const ctx = this.live;
    if (!ctx) return;
    this.thud(ctx.currentTime, 0.08, 0.12, 2400);
    this.clink(0.7, ctx.currentTime + 0.18);
  }

  /** Coins pouring into the tray. */
  won(count = 1) {
    const ctx = this.live;
    if (!ctx) return;
    for (let i = 0; i < Math.min(count, 6); i++) this.clink(0.8, ctx.currentTime + i * 0.05 + Math.random() * 0.03);
  }

  /** A coin over the side, into the gutter. */
  lost() {
    const ctx = this.live;
    if (!ctx) return;
    this.thud(ctx.currentTime, 0.15, 0.1, 500);
  }

  /** A prize into the tray: a little fanfare. */
  prize(points: number) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = points >= 50 ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      this.tone(f, t + i * 0.09, 0.35, 0.1, "square");
      this.tone(f * 2, t + i * 0.09, 0.2, 0.03);
    });
    for (let i = 0; i < 8; i++) this.clink(0.6, t + 0.4 + i * 0.04);
  }

  /** The shelf shaken. Stronger for a synchronized shake. */
  shake(strength: number) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.thud(t, 0.25 + strength * 0.05, 0.25 + 0.1 * strength, 260);
    for (let i = 0; i < 3 + strength * 2; i++) this.clink(0.35, t + 0.02 + Math.random() * 0.2);
  }

  /** TILT: an alarm. */
  tilt() {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 6; i++) this.tone(i % 2 ? 660 : 880, t + i * 0.18, 0.17, 0.08, "square");
  }

  /** The shelf unlocked after a tilt. */
  unlocked() {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(784, t, 0.2, 0.08);
    this.tone(1175, t + 0.1, 0.3, 0.08);
  }
}
