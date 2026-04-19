import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchDatabaseUrlForRenderPostgres } from "./render-postgres-env.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

patchDatabaseUrlForRenderPostgres();

/** Chrome cache — only when Puppeteer may run locally (not on Render remote-inventory mode). */
const skipPuppeteerCache =
  process.env.PUPPETEER_SKIP_BROWSER_INSTALL === "1" || process.env.RENDER === "true";
const puppeteerCache = path.resolve(root, ".puppeteer-chrome");
if (!skipPuppeteerCache && !process.env.PUPPETEER_CACHE_DIR?.trim()) {
  process.env.PUPPETEER_CACHE_DIR = puppeteerCache;
}

function runNpx(args) {
  const r = spawnSync("npx", args, {
    stdio: "inherit",
    env: process.env,
    cwd: root,
    shell: true,
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/**
 * Prefer Render **Release Command** `npm run render:release` so this process only boots Next
 * and binds PORT quickly (avoids deploy health-check timeouts).
 * Set RUN_MIGRATE_ON_START=true to run migrations here (slower cold start).
 */
if (process.env.RUN_MIGRATE_ON_START === "true") {
  console.error("[render-start] RUN_MIGRATE_ON_START=true: running prisma migrate deploy before next start");
  runNpx(["prisma", "migrate", "deploy"]);
}

runNpx(["next", "start"]);
