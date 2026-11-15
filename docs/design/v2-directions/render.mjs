import { createRequire } from "node:module";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../apps/pwa/package.json"));
const { chromium } = require("@playwright/test");
const output = path.join(here, "shots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const direction of ["a", "b"]) {
    const file = path.join(here, `direcao-${direction === "a" ? "a-esmeralda-editorial" : "b-esmeralda-financial"}.html`);
    for (const width of [375, 430]) {
      for (const colorScheme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height: width === 375 ? 812 : 932 }, deviceScaleFactor: 2, colorScheme });
        await page.goto(`file://${file.replaceAll("\\", "/")}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const destination = path.join(output, `${direction}-${width}-${colorScheme}.png`);
        await page.screenshot({ path: destination, fullPage: true });
        console.log(`${path.relative(here, destination)} ${ (await stat(destination)).size } bytes; fonts=${await page.evaluate(() => [...document.fonts].map(f => `${f.family}:${f.status}`).join(","))}`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
