// Captures the README / link-preview screenshots: a phone and a desktop mid-game, a few coins in.
// Usage: node scripts/screenshots.mjs [baseUrl]   (expects `npm run preview` serving baseUrl)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const outDir = process.argv[3] ?? "public/screenshots";
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function shoot(name, viewport, query) {
  const room = `SHOT${Date.now().toString(36).toUpperCase()}`;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => localStorage.setItem("dozer.name", "Pete"));
  const p = await ctx.newPage();
  await p.goto(`${base}/?room=${room}&t=relay&debug${query}`);
  await p.waitForFunction(() => window.dozer?.scene?.counts.coins > 100, null, { timeout: 60_000 });
  await p.click("#start");
  for (const key of ["ArrowLeft", "ArrowLeft", "Space", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Space", "ArrowLeft", "ArrowLeft", "Space"]) {
    await p.keyboard.press(key);
    await p.waitForTimeout(key === "Space" ? 420 : 30);
  }
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${outDir}/${name}.png` });
  await ctx.close();
}

await shoot("phone", { width: 390, height: 780 }, "");
await shoot("desktop", { width: 1280, height: 720 }, "&nomotion");
await browser.close();
console.log("saved to", outDir);
