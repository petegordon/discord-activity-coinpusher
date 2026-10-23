import type { Sim } from "../src/game/host";
import type { Msg, Target } from "../src/net/protocol";
import { Emitter, type Transport, type TransportEvents } from "../src/net/transport";
import type { Body } from "../src/sim/frame";
import type { Out } from "../src/sim/world";

/** Physics stand-in: records what the host asks of it; tests push what falls off. */
export class FakeSim implements Sim {
  locked = false;
  time = 0;
  pusherZ = -0.1;
  resets: number[] = [];
  restored: Body[] | null = null;
  drops: { x: number; aim: number; power: number; spin: number }[] = [];
  shakes: number[] = [];
  outs: Out[] = [];
  tower = false;
  private id = 0;
  reset(seed: number) {
    this.resets.push(seed);
  }
  restore(bodies: Body[], time: number) {
    this.restored = bodies;
    this.time = time;
  }
  drop(x: number, aim: number, power: number, spin: number) {
    this.drops.push({ x, aim, power, spin });
    return ++this.id;
  }
  shake(strength: number) {
    this.shakes.push(strength);
  }
  step(dt: number) {
    this.time += dt;
  }
  takeOuts() {
    const o = this.outs;
    this.outs = [];
    return o;
  }
  takeTower() {
    const t = this.tower;
    this.tower = false;
    return t;
  }
  delta() {
    return { bodies: [] as Body[], gone: [] as number[] };
  }
}

export class FakeTransport implements Transport {
  readonly kind = "relay";
  isHost = false;
  sent: { msg: Msg; to: Target }[] = [];
  events = new Emitter<TransportEvents>();
  on<K extends keyof TransportEvents>(e: K, cb: TransportEvents[K]) {
    this.events.on(e, cb);
  }
  connect() {
    return Promise.resolve();
  }
  send(msg: Msg, to: Target) {
    this.sent.push({ msg, to });
  }
  close() {}
}
