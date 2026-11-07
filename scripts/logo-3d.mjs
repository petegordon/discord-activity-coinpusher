// Close-up "logo" shot inside Carnival Dozer: one of the game's coins (controller heads, star tails)
// standing in front of the striped pusher. Usage:
//   node scripts/logo-3d.mjs out.png '{"fov":15,...}' [baseUrl]   (baseUrl defaults to https://coins.housetandem.com)
// The coin pile settles differently every run, so take a few shots and pick one.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const out = process.argv[2];
const cfg = JSON.parse(process.argv[3] || "{}");
const base = process.argv[4] ?? "https://coins.housetandem.com";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("dozer.name", "Pete"));
const p = await ctx.newPage();
await p.goto(`${base}/?room=LOGO${Date.now().toString(36).toUpperCase()}&t=relay&debug`);
try { await p.waitForFunction(() => window.dozer?.scene?.counts.coins > 150, null, { timeout: 60_000 }); } catch (e) { await p.screenshot({ path: out.replace(".png", "-fail.png") }); console.log(await p.evaluate(() => JSON.stringify({ d: !!window.dozer, c: window.dozer?.scene?.counts }))); throw e; }
await p.waitForTimeout(cfg.settle ?? 2500);
await p.evaluate((cfg) => {
  for (const el of document.body.querySelectorAll("*")) if (!el.contains(document.querySelector("canvas")) && el.tagName !== "CANVAS") el.style.visibility = "hidden";
  const s = window.dozer.scene;
  s.resize = () => {};
  const cv = s.renderer.domElement;
  Object.assign(cv.style, { position: "fixed", left: "0", top: "0", width: "512px", height: "512px", zIndex: 99999, visibility: "visible" });
  s.renderer.setSize(512, 512, false);
  const cam = s.camera, pusher = s.pusher, coins = s.coins;
  const V = cam.position.constructor;
  // Freeze the pusher where it is.
  const pz = cfg.pusherZ ?? pusher.position.z;
  Object.defineProperty(pusher.position, "z", { get: () => pz, set() {} });
  const front = pz + 0.2; // pusher front face z
  for (const t of s.tracks.values()) if (t.mesh) t.mesh.visible = cfg.prizes ?? false;
  for (const c of s.chutes.values()) c.group.visible = false;
  s.dropLight.visible = false;
  s.renderer.toneMappingExposure = cfg.exp ?? 1;
  // The game's own coin materials (edge, heads, tails), in a solid gold instead of the per-instance tint.
  const mats = coins.material.map((m) => { const c = m.clone(); c.color.set(cfg.gold ?? "#ffc94a"); if (cfg.env != null) c.envMapIntensity = cfg.env; if (cfg.metal != null) c.metalness = cfg.metal; if (cfg.rough != null) c.roughness = cfg.rough; if (cfg.bump != null && c.bumpMap) c.bumpScale = cfg.bump; return c; });
  const hero = new pusher.constructor(new coins.geometry.constructor(0.022, 0.022, 0.008, 96), mats);
  hero.castShadow = hero.receiveShadow = true;
  const r = 0.022;
  hero.position.set(cfg.hx ?? 0, (cfg.hy ?? r + 0.003), front + (cfg.hz ?? 0.028));
  hero.rotation.set((cfg.tails ? -Math.PI / 2 : Math.PI / 2) + (cfg.tiltX ?? -0.12), cfg.tiltY ?? 0.35, cfg.tiltZ ?? 0.12, "YXZ");
  s.cabinet.add(hero);
  // Clear a lane of pile coins between the camera and the hero coin.
  if (cfg.lane !== false) {
    const hz = hero.position.z, hx = hero.position.x, w = cfg.laneW ?? 0.06;
    const orig = coins.setMatrixAt.bind(coins);
    const zero = s.tmp.clone().makeScale(0, 0, 0);
    coins.setMatrixAt = (i, m) => { const e = m.elements; orig(i, (e[14] > hz - (cfg.laneBack ?? 0.012) && Math.abs(e[12] - hx) < w) ? zero : m); };
  }
  if (cfg.light !== false) {
    const L = s.dropLight.constructor;
    const key = new L("#fff1cf", cfg.keyI ?? 0.6, 0.5, 1.5);
    key.position.set(hero.position.x + 0.05, hero.position.y + 0.06, hero.position.z + 0.08);
    s.cabinet.add(key);
  }
  cam.fov = cfg.fov ?? 32;
  cam.aspect = 1;
  cam.position.set(...(cfg.cam ? cfg.cam.map((v, i) => i === 2 ? front + v : v) : [0.05, 0.06, front + 0.2]));
  cam.lookAt(new V(...(cfg.look ?? [hero.position.x - 0.004, hero.position.y + 0.004, hero.position.z - 0.02])));
  cam.updateProjectionMatrix();
}, cfg);
await p.waitForTimeout(500);
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 512, height: 512 } });
await browser.close();
