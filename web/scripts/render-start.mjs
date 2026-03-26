import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Render Postgres expects TLS; without sslmode=require Prisma often gets P1017
 * ("Server has closed the connection"). See render.com/docs/postgresql-creating-connecting
 *
 * Only applied when RENDER=true (render.com/docs/environment-variables).
 */
function patchDatabaseUrlForRender() {
  if (process.env.RENDER !== "true") return;
  const url = process.env.DATABASE_URL;
  if (!url || /sslmode=/i.test(url)) return;
  if (!/^postgres(ql)?:\/\//i.test(url)) return;
  process.env.DATABASE_URL = url.includes("?")
    ? `${url}&sslmode=require`
    : `${url}?sslmode=require`;
}

patchDatabaseUrlForRender();

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

runNpx(["prisma", "migrate", "deploy"]);
runNpx(["next", "start"]);
