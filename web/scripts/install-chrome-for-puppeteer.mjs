/**
 * Downloads Chrome for Testing into web/.puppeteer-chrome (not ~/.cache), so the binary
 * is part of the Render deploy bundle. Set PUPPETEER_SKIP_BROWSER_INSTALL=1 to skip (e.g. CI without Puppeteer).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.resolve(root, ".puppeteer-chrome");

if (process.env.PUPPETEER_SKIP_BROWSER_INSTALL === "1") {
  console.log("[install-chrome-for-puppeteer] skip (PUPPETEER_SKIP_BROWSER_INSTALL=1)");
  process.exit(0);
}

fs.mkdirSync(cacheDir, { recursive: true });
const env = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir };

const r = spawnSync("npx", ["puppeteer", "browsers", "install", "chrome"], {
  stdio: "inherit",
  cwd: root,
  env,
  shell: true,
});

if (r.status !== 0) {
  console.error("[install-chrome-for-puppeteer] failed, exit", r.status ?? r.signal);
  process.exit(r.status ?? 1);
}

console.log("[install-chrome-for-puppeteer] ok PUPPETEER_CACHE_DIR=", cacheDir);
