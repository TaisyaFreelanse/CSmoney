#!/usr/bin/env node
/**
 * Сравнение egress IP через Bright Data:
 * 1) «Как в .env» — PROXY_USERNAME без изменений (эквивалент вашего ручного curl).
 * 2) Как в steam-worker при липкой сессии: -session-{id} (если в .env ещё нет суффикса -session-).
 *
 * 407 на шаге 2 при успешном шаге 1 → зона/учётка не принимает -session-{id};
 *   см. PROXY_STICKY_SESSION=0 или username с плейсхолдером {accountId} в .env.example.
 *
 * Запуск: cd steam-worker && npm run brightdata:compare-sticky-ips
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnvFile(p) {
  const o = {};
  if (!fs.existsSync(p)) return o;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    o[k] = v;
  }
  return o;
}

function curlProxy({ host, port, proxyUser, password, url }) {
  const r = spawnSync(
    "curl",
    [
      "-sS",
      "-i",
      "--max-time",
      "30",
      "--proxy",
      `http://${host}:${port}`,
      "--proxy-user",
      `${proxyUser}:${password}`,
      url,
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 },
  );
  if (r.error) {
    return { ok: false, text: `spawn_error: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    const hint = err.includes("407") ? " (proxy auth rejected — check username format / zone)" : "";
    return { ok: false, text: `curl_exit_${r.status}${hint}` };
  }
  return { ok: true, text: r.stdout || "" };
}

function parseResponse(text) {
  const norm = text.replace(/\r\n/g, "\n");
  const idx = norm.indexOf("\n\n");
  const head = idx >= 0 ? norm.slice(0, idx) : norm;
  const body = idx >= 0 ? norm.slice(idx + 2).trim() : "";
  const first = head.split("\n")[0] || "";
  const ip = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return { firstLine: first, head: head.split("\n").slice(0, 15).join("\n"), body: body.slice(0, 400), ip: ip ? ip[0] : null };
}

const env = loadEnvFile(path.join(root, ".env"));
const h = env.PROXY_HOST?.trim();
const port = env.PROXY_PORT?.trim();
const baseUser = env.PROXY_USERNAME?.trim();
const pw = env.PROXY_PASSWORD ?? "";

let accIds = ["acc1", "acc2"];
try {
  const arr = JSON.parse(env.STEAM_ACCOUNTS || "[]");
  if (Array.isArray(arr) && arr.length) {
    accIds = arr.map((a) => (typeof a?.id === "string" ? a.id.trim() : "")).filter(Boolean);
  }
} catch {
  /* ignore */
}
if (!accIds.length) accIds = ["acc1", "acc2"];

const url =
  process.argv[2]?.startsWith("http") ?
    process.argv[2]
  : "https://geo.brdtest.com/welcome.txt?product=isp&method=native";

if (!h || !port || !baseUser || !pw) {
  console.error("Missing PROXY_HOST, PROXY_PORT, PROXY_USERNAME, or PROXY_PASSWORD in .env");
  process.exit(1);
}

const stickyOff =
  env.PROXY_STICKY_SESSION === "0" || env.PROXY_STICKY_SESSION === "false";

console.log("URL:", url);
console.log("PROXY_STICKY_SESSION off:", stickyOff);

console.log("\n=== A) Baseline: PROXY_USERNAME exactly as in .env (no -session- appended) ===");
const baseRes = curlProxy({ host: h, port, proxyUser: baseUser, password: pw, url });
if (!baseRes.ok) {
  console.log("FAILED:", baseRes.text);
} else {
  const p = parseResponse(baseRes.text);
  console.log(p.head);
  console.log("body:", p.body || "(empty)");
  console.log("parsed IP:", p.ip ?? "(none)");
}

const hasSessionSuffix = /-session-[A-Za-z0-9_-]+$/.test(baseUser);

if (hasSessionSuffix || stickyOff) {
  console.log(
    "\n=== B) Skipped per-account -session-{id} curl: .env username already ends with -session- OR PROXY_STICKY_SESSION=0 ===",
  );
  console.log("Worker uses username as configured; compare login IP vs worker IP in Bright Data dashboard.");
  process.exit(0);
}

const results = [];
for (const accId of accIds) {
  const user = `${baseUser}-session-${accId}`;
  console.log(`\n=== B-${accId}) Puppeteer-style user: …-session-${accId} (password from .env) ===`);
  const res = curlProxy({ host: h, port, proxyUser: user, password: pw, url });
  if (!res.ok) {
    console.log("FAILED:", res.text);
    results.push({ accId, ip: null, fail: true });
    continue;
  }
  const p = parseResponse(res.text);
  console.log(p.head);
  console.log("body:", p.body || "(empty)");
  console.log("parsed IP:", p.ip ?? "(none)");
  results.push({ accId, ip: p.ip, fail: false });
}

console.log("\n=== Summary ===");
console.log("baseline (.env user):", baseRes.ok ? parseResponse(baseRes.text).ip ?? "(no ip)" : "failed");
for (const r of results) {
  console.log(`${r.accId} (-session-):`, r.fail ? "failed" : r.ip ?? "(no ip)");
}

if (baseRes.ok && results.some((r) => r.fail)) {
  console.log(
    "\n→ Baseline OK, but -session-{accountId} gets 407: Bright Data отклоняет формат логина с суффиксом сессии для этой зоны/продукта.",
  );
  console.log(
    "  Варианты: PROXY_STICKY_SESSION=0 и отдельные учётки; или username с {accountId} в .env (см. puppeteerProxy.js).",
  );
} else if (baseRes.ok && results.every((r) => !r.fail)) {
  const ips = results.map((r) => r.ip).filter(Boolean);
  if (ips.length >= 2 && new Set(ips).size === 1) {
    console.log("\n→ Один и тот же IP на обоих sticky — ожидайте различия только если зона выдаёт разные выходы по session-id.");
  } else if (ips.length >= 2) {
    console.log("\n→ Разные IP — sticky -session-{id} для этой зоны принимается.");
  }
}
