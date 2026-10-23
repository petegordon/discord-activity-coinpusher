import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { chuteX, COIN, TABLE } from "../game/rules";
import { KIND_COIN, KIND_PRIZE, type Body, type Frame } from "../sim/frame";
import { PRIZE_SIZES } from "../sim/prizes";

const FOV = 38;
/** Render this far behind the newest frame, so there's always a frame on each side to blend between. */
const INTERP_MS = 110;
const MAX_COINS = 320;
const W = TABLE.halfWidth;

type Sample = { ms: number; p: THREE.Vector3; q: THREE.Quaternion };
type Track = {
  kind: number;
  samples: Sample[];
  mesh?: THREE.Object3D;
  /** Each coin's own shade of gold, so the pile isn't one flat colour. */
  shade?: THREE.Color;
  /** A freshly dropped coin: who dropped it (their colour) and when it appeared. */
  glow?: { color: THREE.Color; born: number };
};

const PRIZE_LOOKS = [
  { color: "#e63946", ribbon: "#ffd166", label: "10" },
  { color: "#2a9d8f", ribbon: "#f1faee", label: "20" },
  { color: "#9b5de5", ribbon: "#fee440", label: "30" },
  { color: "#f15bb5", ribbon: "#ffffff", label: "50" },
];

/** A wrapped gift: coloured paper, a ribbon cross, and its points on the front. */
function giftTexture(look: (typeof PRIZE_LOOKS)[number], withLabel: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = look.color;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "rgba(255,255,255,0.12)";
  for (let i = -128; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 128);
    g.lineTo(i + 128, 0);
    g.lineTo(i + 136, 0);
    g.lineTo(i + 8, 128);
    g.fill();
  }
  g.fillStyle = look.ribbon;
  g.fillRect(54, 0, 20, 128);
  if (withLabel) {
    g.fillRect(0, 54, 128, 20);
    g.beginPath();
    g.arc(64, 64, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = look.color;
    g.font = "bold 34px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(look.label, 64, 66);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function marqueeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#7a0e1c");
  grad.addColorStop(1, "#3d0710");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 256);
  // Circus stripes fanning out behind the title.
  g.save();
  g.translate(512, 300);
  for (let i = 0; i < 24; i++) {
    g.rotate(Math.PI / 12);
    g.fillStyle = i % 2 ? "rgba(255,209,102,0.10)" : "rgba(255,255,255,0.04)";
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-60, -700);
    g.lineTo(60, -700);
    g.fill();
  }
  g.restore();
  g.font = "900 96px Georgia, 'Times New Roman', serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 14;
  g.strokeStyle = "#2b0409";
  g.strokeText("CARNIVAL DOZER", 512, 118);
  const gold = g.createLinearGradient(0, 60, 0, 170);
  gold.addColorStop(0, "#fff3b0");
  gold.addColorStop(0.5, "#ffd166");
  gold.addColorStop(1, "#d48c1f");
  g.fillStyle = gold;
  g.fillText("CARNIVAL DOZER", 512, 118);
  g.font = "700 30px system-ui, sans-serif";
  g.fillStyle = "#ffe8a3";
  g.fillText("★  PUSH  ·  SHAKE  ·  WIN  ★", 512, 212);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * The playfield, drawn once across the whole shelf (back at the top of the
 * canvas, front edge at the bottom): carnival-blue felt with gold diamonds,
 * brighter in the middle, and a lit band along the front edge where coins win.
 */
function floorTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  const felt = g.createRadialGradient(256, 300, 40, 256, 300, 420);
  felt.addColorStop(0, "#3a8ee8");
  felt.addColorStop(0.6, "#2163b8");
  felt.addColorStop(1, "#163f80");
  g.fillStyle = felt;
  g.fillRect(0, 0, 512, 512);
  // Gold diamonds in rows.
  g.fillStyle = "rgba(255, 214, 110, 0.22)";
  for (let y = 24; y < 470; y += 48) {
    for (let x = (y / 48) % 2 ? 24 : 48; x < 512; x += 48) {
      g.beginPath();
      g.moveTo(x, y - 9);
      g.lineTo(x + 7, y);
      g.lineTo(x, y + 9);
      g.lineTo(x - 7, y);
      g.fill();
    }
  }
  // The win zone along the front edge: gold in the tray's width, dark over the gutters.
  const trayPx = (TABLE.trayHalfWidth / TABLE.halfWidth) * 256;
  const band = g.createLinearGradient(0, 470, 0, 512);
  band.addColorStop(0, "rgba(255, 209, 102, 0)");
  band.addColorStop(1, "rgba(255, 209, 102, 0.75)");
  g.fillStyle = band;
  g.fillRect(256 - trayPx, 462, trayPx * 2, 50);
  g.fillStyle = "rgba(40, 6, 14, 0.75)";
  g.fillRect(0, 488, 256 - trayPx, 24);
  g.fillRect(256 + trayPx, 488, 256 - trayPx, 24);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Red and cream circus stripes for the pusher's top. */
function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? "#fff1d6" : "#d7263d";
    g.fillRect(i * 16, 0, 16, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A coin just dropped glows in its dropper's colour for this long (ms). */
const GLOW_MS = 1600;
const GOLD = new THREE.Color("#ffc94a");

export type Burst = "coin" | "prize" | "lost";

/**
 * The coin pusher cabinet, seen from where you'd stand at the machine.
 * Coins and prizes come from the host's frames and are drawn a little in the
 * past, blending between the two frames either side.
 */
export class DozerScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 20);
  private cabinet = new THREE.Group();
  private pusher: THREE.Mesh;
  private coins: THREE.InstancedMesh;
  private tracks = new Map<number, Track>();
  private pusherSamples: { ms: number; z: number }[] = [];
  /** host clock ms − local performance.now(), the largest seen (least delayed). */
  private clockOffset: number | null = null;
  private lastFrameMs = 0;
  private chutes = new Map<string, { group: THREE.Group; aim: number; target: number; flash: number; color: THREE.Color; mat: THREE.MeshStandardMaterial }>();
  /** Colours of drops announced but whose coin hasn't arrived in a frame yet. */
  private pendingGlows: { color: THREE.Color; at: number }[] = [];
  /** A small light that rides along with the newest dropped coin. */
  private dropLight = new THREE.PointLight("#ffffff", 0, 0.35, 1.5);
  private tmpC = new THREE.Color();
  private bulbs: THREE.Mesh[] = [];
  private bulbMat: THREE.MeshStandardMaterial[] = [];
  private shakeT = 0;
  private shakeStrength = 0;
  private tilt = 0;
  private locked = false;
  private particles: { mesh: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private prizeMats: THREE.Material[][] = [];
  private prizeGeoms: THREE.BoxGeometry[] = [];
  private gameId = "";
  private clock = new THREE.Clock();
  private tmp = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private basePos = new THREE.Vector3();

  constructor(private readonly container: HTMLElement) {
    const lowPower = /Android|iPhone|iPad/i.test(navigator.userAgent) && Math.min(screen.width, screen.height) < 500;
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, lowPower ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = lowPower ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#140a12");
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(this.cabinet);

    this.pusher = this.buildCabinet();
    this.buildLights();

    const coinGeo = new THREE.CylinderGeometry(COIN.radius, COIN.radius, COIN.thickness, 28);
    // White here; each coin's gold (and a fresh drop's glow) comes from its instance colour.
    const coinMat = new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0.85, roughness: 0.36, envMapIntensity: 0.8 });
    this.coins = new THREE.InstancedMesh(coinGeo, coinMat, MAX_COINS);
    for (let i = 0; i < MAX_COINS; i++) this.coins.setColorAt(i, GOLD);
    this.coins.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.cabinet.add(this.dropLight);
    this.coins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coins.castShadow = true;
    this.coins.receiveShadow = true;
    this.coins.count = 0;
    this.coins.frustumCulled = false;
    this.cabinet.add(this.coins);

    PRIZE_SIZES.forEach(([hx, hy, hz], tier) => {
      this.prizeGeoms.push(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2));
      const look = PRIZE_LOOKS[tier];
      const side = new THREE.MeshStandardMaterial({ map: giftTexture(look, true), roughness: 0.55 });
      const top = new THREE.MeshStandardMaterial({ map: giftTexture(look, false), roughness: 0.55 });
      // Box faces: +x, −x, +y, −y, +z, −z.
      this.prizeMats.push([side, side, top, top, side, side]);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  private buildCabinet(): THREE.Mesh {
    const c = this.cabinet;
    const gold = new THREE.MeshStandardMaterial({ color: "#e8b04a", metalness: 1, roughness: 0.28 });
    const red = new THREE.MeshStandardMaterial({ color: "#9e1430", roughness: 0.5, metalness: 0.1 });
    const stripes = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.4, metalness: 0.1 });

    // Playfield: one texture over the top face, front edge at the bottom of it.
    const feltMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.55, metalness: 0.05 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: "#163f80", roughness: 0.6 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.02, TABLE.frontZ - TABLE.backZ + 0.02), [edgeMat, edgeMat, feltMat, edgeMat, edgeMat, edgeMat]);
    floor.position.set(0, -0.01, (TABLE.frontZ + TABLE.backZ) / 2);
    floor.receiveShadow = true;
    c.add(floor);

    // Front lip: gold where coins win, dark over the side gutters.
    const lipZ = TABLE.frontZ + 0.012;
    const tray = new THREE.Mesh(new THREE.BoxGeometry(TABLE.trayHalfWidth * 2, 0.006, 0.024), gold);
    tray.position.set(0, -0.003, lipZ);
    c.add(tray);
    for (const s of [-1, 1]) {
      const gw = W - TABLE.trayHalfWidth;
      const gutter = new THREE.Mesh(new THREE.BoxGeometry(gw, 0.006, 0.024), new THREE.MeshStandardMaterial({ color: "#2a1418", roughness: 0.8 }));
      gutter.position.set(s * (TABLE.trayHalfWidth + gw / 2), -0.003, lipZ);
      c.add(gutter);
    }
    // The win tray below the lip.
    const bin = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 0.04, 0.05, 0.08), red);
    bin.position.set(0, -0.06, TABLE.frontZ + 0.06);
    c.add(bin);
    const binFace = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 0.06, 0.1, 0.01), gold);
    binFace.position.set(0, -0.08, TABLE.frontZ + 0.105);
    c.add(binFace);

    // Cabinet sides: red panels low, glass above, gold posts.
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, TABLE.frontZ - TABLE.backZ + 0.08), red);
      panel.position.set(s * (W + 0.015), 0.0, (TABLE.frontZ + TABLE.backZ) / 2);
      panel.receiveShadow = true;
      c.add(panel);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(0.004, 0.22, TABLE.frontZ - TABLE.backZ),
        new THREE.MeshPhysicalMaterial({ color: "#cfe8ff", roughness: 0.05, transmission: 0.9, transparent: true, opacity: 0.18, metalness: 0 }),
      );
      glass.position.set(s * (W + 0.004), 0.15, (TABLE.frontZ + TABLE.backZ) / 2);
      c.add(glass);
      for (const z of [TABLE.backZ, TABLE.frontZ]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 12), gold);
        post.position.set(s * (W + 0.015), 0.12, z);
        c.add(post);
      }
    }

    // Back wall with the marquee.
    const marquee = marqueeTexture();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 0.06, 0.34, 0.03), new THREE.MeshStandardMaterial({ map: marquee, roughness: 0.6, emissive: "#ffffff", emissiveIntensity: 0.22, emissiveMap: marquee }));
    wall.position.set(0, TABLE.pusherTop + 0.006 + 0.17, TABLE.backZ - 0.015);
    c.add(wall);
    // Chase lights along the marquee's top.
    const bulbGeo = new THREE.SphereGeometry(0.007, 10, 8);
    for (let i = 0; i < 22; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: "#ffe9a8", emissive: "#ffcf5a", emissiveIntensity: 1 });
      const b = new THREE.Mesh(bulbGeo, mat);
      b.position.set(-W + (i * W * 2) / 21, TABLE.pusherTop + 0.35, TABLE.backZ - 0.0);
      this.bulbs.push(b);
      this.bulbMat.push(mat);
      c.add(b);
    }
    const trim = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 0.08, 0.012, 0.04), gold);
    trim.position.set(0, TABLE.pusherTop + 0.012, TABLE.backZ - 0.012);
    c.add(trim);

    // The pusher: circus stripes on top, a gold face with a red band.
    const pusher = new THREE.Mesh(new THREE.BoxGeometry(W * 2 - 0.004, TABLE.pusherTop, 0.4), [red, red, stripes, red, gold, red]);
    pusher.castShadow = true;
    pusher.receiveShadow = true;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(W * 2 - 0.004, TABLE.pusherTop * 0.3, 0.002), red);
    stripe.position.set(0, 0, 0.2005);
    pusher.add(stripe);
    pusher.position.set(0, TABLE.pusherTop / 2, TABLE.pusherMinZ - 0.2);
    c.add(pusher);
    return pusher;
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight("#fff0dc", "#2a1030", 0.45));
    // A showcase spotlight over the shelf, from above the player's head: bright pool on the coins, soft shadows.
    const spot = new THREE.SpotLight("#fff6e6", 3.2, 2.2, 0.62, 0.55, 1.2);
    spot.position.set(0.06, 0.95, 0.42);
    spot.target.position.set(0, 0, 0.02);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0004;
    spot.shadow.camera.near = 0.3;
    spot.shadow.camera.far = 2;
    this.scene.add(spot, spot.target);
    // Warm fill from the front, low, to light the faces of the coins at the edge.
    const fill = new THREE.DirectionalLight("#ffb35c", 0.5);
    fill.position.set(-0.2, 0.25, 1);
    this.scene.add(fill);
    // The marquee's glow spilling onto the back of the shelf.
    const warm = new THREE.PointLight("#ff8a3c", 0.6, 0.9, 1.5);
    warm.position.set(0, 0.22, TABLE.backZ + 0.06);
    this.scene.add(warm);
    // Carnival colour on the sides: magenta left, cyan right.
    const left = new THREE.PointLight("#ff4fb4", 0.7, 0.8, 1.5);
    left.position.set(-W - 0.02, 0.16, 0.05);
    const right = new THREE.PointLight("#3fd8ff", 0.7, 0.8, 1.5);
    right.position.set(W + 0.02, 0.16, 0.05);
    this.scene.add(left, right);
  }

  /** Each player's chute, in join order, in their colour. */
  setPlayers(players: { id: string; color: string }[]) {
    const keep = new Set(players.map((p) => p.id));
    for (const [id, c] of this.chutes) {
      if (!keep.has(id)) {
        this.cabinet.remove(c.group);
        this.chutes.delete(id);
      }
    }
    players.forEach((p, i) => {
      let c = this.chutes.get(p.id);
      if (!c) {
        const group = new THREE.Group();
        const color = new THREE.Color(p.color);
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2, emissive: color, emissiveIntensity: 0.3 });
        const rim = new THREE.MeshStandardMaterial({ color: "#ffe3a0", metalness: 1, roughness: 0.25 });
        // An open trough tipped toward the shelf, with gold rails.
        const trough = new THREE.Group();
        const base = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.005, 0.085), mat);
        trough.add(base);
        for (const s of [-1, 1]) {
          const side = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.024, 0.085), mat);
          side.position.set(s * 0.032, 0.012, 0);
          trough.add(side);
          const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.088, 8), rim);
          rail.rotation.x = Math.PI / 2;
          rail.position.set(s * 0.032, 0.025, 0);
          trough.add(rail);
        }
        trough.rotation.x = 0.35;
        trough.position.set(0, 0, 0.025);
        group.add(trough);
        // The aim line along the shelf, where the coin will head, ending in a ring where a medium flick lands.
        const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
        const floorY = -TABLE.chuteY + TABLE.pusherTop + 0.003;
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.008, 0.2), glowMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(0, floorY, 0.11);
        group.add(line);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.024, 28), glowMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, floorY, 0.21);
        group.add(ring);
        this.cabinet.add(group);
        c = { group, aim: 0, target: 0, flash: 0, color, mat };
        this.chutes.set(p.id, c);
      }
      c.group.position.set(chuteX(i, players.length), TABLE.chuteY, TABLE.backZ + 0.01);
    });
  }

  setAim(id: string, aim: number) {
    const c = this.chutes.get(id);
    if (c) c.target = aim;
  }

  /** A coin just left `id`'s chute. */
  dropped(id: string) {
    const c = this.chutes.get(id);
    if (!c) return;
    c.flash = 1;
    this.pendingGlows.push({ color: c.color, at: performance.now() });
  }

  /** Jolt the cabinet. */
  shake(strength: number) {
    this.shakeT = 0.45;
    this.shakeStrength = strength;
  }

  setTilt(tilt: number, locked: boolean) {
    this.tilt = tilt;
    this.locked = locked;
  }

  /** Sparkles where something fell off the front at `x`. */
  burst(kind: Burst, x: number) {
    const n = kind === "prize" ? 40 : kind === "coin" ? 8 : 4;
    const colors = kind === "prize" ? ["#ffd166", "#f15bb5", "#00b4d8", "#80b918", "#ffffff"] : kind === "coin" ? ["#ffe08a"] : ["#6b5560"];
    const geo = new THREE.PlaneGeometry(kind === "prize" ? 0.012 : 0.007, kind === "prize" ? 0.006 : 0.007);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true }));
      mesh.position.set(x, 0.01, TABLE.frontZ + 0.02);
      const speed = kind === "prize" ? 0.9 : 0.4;
      this.particles.push({ mesh, v: new THREE.Vector3((Math.random() - 0.5) * speed, (0.4 + Math.random()) * speed, (Math.random() * 0.6) * speed), life: 1.2 });
      this.cabinet.add(mesh);
    }
  }

  /** Apply a frame from the host. `bodies` is unused here; the frame's own deltas drive the tracks. */
  frame(f: Frame, delta: Body[]) {
    const local = performance.now();
    if (f.gameId !== this.gameId) {
      this.gameId = f.gameId;
      this.clearTracks();
    }
    const offset = f.ms - local;
    // The newest frame arrives least delayed; follow it quickly when it's ahead, slowly when behind (jitter).
    if (this.clockOffset === null || Math.abs(offset - this.clockOffset) > 1000) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * (offset > this.clockOffset ? 0.3 : 0.02);
    if (f.key) {
      const seen = new Set(delta.map((b) => b.id));
      for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.removeTrack(id);
    }
    for (const id of f.gone) this.removeTrack(id);
    // Drops first: the dropped coin arrives in this same frame.
    for (const e of f.events) if (e.k === "drop") this.dropped(e.by);
    for (const b of delta) {
      let t = this.tracks.get(b.id);
      if (!t || t.kind !== b.kind) {
        if (t) this.removeTrack(b.id);
        t = { kind: b.kind, samples: [] };
        if (b.kind === KIND_COIN) {
          t.shade = GOLD.clone().offsetHSL((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.12);
          // A coin that appears just after a drop was announced is that drop's coin.
          while (this.pendingGlows.length && local - this.pendingGlows[0].at > 1500) this.pendingGlows.shift();
          const glow = this.pendingGlows.shift();
          if (glow) t.glow = { color: glow.color, born: local };
        } else {
          const tier = Math.max(0, Math.min(PRIZE_SIZES.length - 1, b.kind - KIND_PRIZE));
          const mesh = new THREE.Mesh(this.prizeGeoms[tier], this.prizeMats[tier]);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.cabinet.add(mesh);
          t.mesh = mesh;
        }
        this.tracks.set(b.id, t);
      }
      const last = t.samples.at(-1);
      // A body that sat still (and wasn't sent) held its pose until the previous frame.
      if (last && last.ms < this.lastFrameMs) t.samples.push({ ms: this.lastFrameMs, p: last.p.clone(), q: last.q.clone() });
      t.samples.push({ ms: f.ms, p: new THREE.Vector3(...b.p), q: new THREE.Quaternion(...b.q) });
      while (t.samples.length > 4) t.samples.shift();
    }
    this.pusherSamples.push({ ms: f.ms, z: f.pusher });
    while (this.pusherSamples.length > 6) this.pusherSamples.shift();
    this.lastFrameMs = f.ms;
    this.setTilt(f.tilt, f.locked > 0);
  }

  private clearTracks() {
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
    this.pusherSamples = [];
    this.lastFrameMs = 0;
  }

  private removeTrack(id: number) {
    const t = this.tracks.get(id);
    if (!t) return;
    if (t.mesh) this.cabinet.remove(t.mesh);
    this.tracks.delete(id);
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Stand at the front of the machine, looking down over the shelf; back off until it all fits.
    const pitch = THREE.MathUtils.degToRad(this.camera.aspect > 1.2 ? 40 : 50);
    const target = new THREE.Vector3(0, 0.1, -0.02);
    // The tray's front corners and the marquee's top corners must all be on screen.
    const keep = [-1, 1].flatMap((s) => [
      new THREE.Vector3(s * (W + 0.03), -0.04, TABLE.frontZ + 0.1),
      new THREE.Vector3(s * (W + 0.03), TABLE.pusherTop + 0.37, TABLE.backZ - 0.03),
    ]);
    const p = new THREE.Vector3();
    for (let dist = 0.4; dist < 4; dist += 0.02) {
      this.basePos.set(0, target.y + Math.sin(pitch) * dist, target.z + Math.cos(pitch) * dist);
      this.camera.position.copy(this.basePos);
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      if (keep.every((k) => (p.copy(k).project(this.camera), Math.abs(p.x) < 0.97 && Math.abs(p.y) < 0.95))) break;
    }
  }

  /** Blend a track's samples at host time `ms`. */
  private poseAt(t: Track, ms: number): boolean {
    const s = t.samples;
    if (!s.length) return false;
    if (ms <= s[0].ms || s.length === 1) {
      this.tmpP.copy(s[0].p);
      this.tmpQ.copy(s[0].q);
      if (s.length === 1 || ms <= s[0].ms) return true;
    }
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (ms >= a.ms) {
        const k = b.ms > a.ms ? Math.min(1, (ms - a.ms) / (b.ms - a.ms)) : 1;
        this.tmpP.lerpVectors(a.p, b.p, k);
        this.tmpQ.slerpQuaternions(a.q, b.q, k);
        return true;
      }
    }
    return true;
  }

  private render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();
    const ms = (this.clockOffset ?? 0) + now - INTERP_MS;

    let n = 0;
    let newest: { born: number; color: THREE.Color; p: THREE.Vector3; k: number } | null = null;
    for (const t of this.tracks.values()) {
      if (!this.poseAt(t, ms)) continue;
      if (t.kind === KIND_COIN) {
        if (n >= MAX_COINS) continue;
        this.tmp.compose(this.tmpP, this.tmpQ, this.one);
        this.coins.setMatrixAt(n, this.tmp);
        // A fresh drop glows in its dropper's colour, fading back to gold as it settles.
        const c = this.tmpC.copy(t.shade ?? GOLD);
        if (t.glow) {
          const k = 1 - (now - t.glow.born) / GLOW_MS;
          if (k <= 0) t.glow = undefined;
          else {
            c.lerp(t.glow.color, 0.55 * k).multiplyScalar(1 + 1.4 * k);
            if (!newest || t.glow.born > newest.born) newest = { born: t.glow.born, color: t.glow.color, p: this.tmpP.clone(), k };
          }
        }
        this.coins.setColorAt(n, c);
        n++;
      } else if (t.mesh) {
        t.mesh.position.copy(this.tmpP);
        t.mesh.quaternion.copy(this.tmpQ);
      }
    }
    this.coins.count = n;
    this.coins.instanceMatrix.needsUpdate = true;
    if (this.coins.instanceColor) this.coins.instanceColor.needsUpdate = true;
    // The light rides just above the newest dropped coin, so you can follow it down the shelf.
    if (newest) {
      this.dropLight.color.copy(newest.color);
      this.dropLight.position.copy(newest.p).add(this.tmpP.set(0, 0.03, 0));
      this.dropLight.intensity = 1.6 * newest.k;
    } else this.dropLight.intensity = 0;

    const ps = this.pusherSamples;
    if (ps.length) {
      let z = ps[ps.length - 1].z;
      for (let i = ps.length - 1; i > 0; i--) {
        if (ms >= ps[i - 1].ms) {
          const k = ps[i].ms > ps[i - 1].ms ? Math.min(1, (ms - ps[i - 1].ms) / (ps[i].ms - ps[i - 1].ms)) : 1;
          z = ps[i - 1].z + (ps[i].z - ps[i - 1].z) * k;
          break;
        }
        z = ps[0].z;
      }
      this.pusher.position.z = z - 0.2;
    }

    for (const c of this.chutes.values()) {
      c.aim += (c.target - c.aim) * Math.min(1, dt * 14);
      c.group.rotation.y = c.aim;
      c.flash = Math.max(0, c.flash - dt * 3);
      c.group.scale.setScalar(1 + c.flash * 0.25);
      c.mat.emissiveIntensity = 0.3 + c.flash * 1.4;
    }

    // Chase lights; red and flashing while tilted.
    const tsec = now / 1000;
    this.bulbMat.forEach((m, i) => {
      if (this.locked) {
        m.emissive.set("#ff2030");
        m.emissiveIntensity = Math.sin(tsec * 18) > 0 ? 2.2 : 0.2;
      } else {
        m.emissive.set(this.tilt > 65 ? "#ff7a3c" : "#ffcf5a");
        m.emissiveIntensity = (Math.floor(tsec * 6) + i) % 3 === 0 ? 2 : 0.35;
      }
    });

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.v.y -= 1.6 * dt;
      p.mesh.position.addScaledVector(p.v, dt);
      p.mesh.rotation.x += dt * 9;
      p.mesh.rotation.z += dt * 6;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life);
      if (p.life <= 0) {
        this.cabinet.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const a = this.shakeT * 0.012 * this.shakeStrength;
      this.cabinet.position.set(Math.sin(now * 0.09) * a * 0.4, Math.abs(Math.sin(now * 0.06)) * a, Math.sin(now * 0.07) * a * 0.3);
    } else this.cabinet.position.set(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
  }

  /** For tests: how many coins and prizes are drawn. */
  get counts() {
    let prizes = 0;
    for (const t of this.tracks.values()) if (t.kind !== KIND_COIN) prizes++;
    return { coins: this.coins.count, prizes };
  }
}
