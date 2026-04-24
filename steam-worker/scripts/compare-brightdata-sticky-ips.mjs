#!/usr/bin/env node
/**
 * Сравнение egress IP по Bright Data для каждого id из STEAM_ACCOUNTS (sticky -session-{id}).
 * Запуск на VPS: cd steam-worker && node scripts/compare-brightdata-sticky-ips.mjs
 * Секреты в stdout не печатаются — только HTTP-заголовки и тело welcome.txt (обычно одна строка IP).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const results = [];
for (const accId of accIds) {
  const user =
    /-session-[A-Za-z0-9_-]+$/.test(baseUser) ? baseUser : `${baseUser}-session-${accId}`;
  let out = "";
  try {
    out = execFileSync(
      "curl",
      [
        "-sS",
        "-i",
        "--max-time",
        "30",
        "--proxy",
        `http://${h}:${port}`,
        "--proxy-user",
        `${user}:${pw}`,
        url,
      ],
      { encoding: "utf8", maxBuffer: 512 * 1024 },
    );
  } catch (e) {
    out = `curl_error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const lines = out.replace(/\r\n/g, "\n").split("\n");
  const statusLine = lines[0] || "";
  const body = lines.slice(lines.indexOf("") + 1).join("\n").trim() || out.slice(-200);
  results.push({ accId, statusLine, bodyPreview: body.slice(0, 200) });
  console.log(`\n=== ${accId} (user ends with session for this id) ===`);
  console.log(lines.slice(0, 20).join("\n"));
  if (body && !body.includes("curl_error")) console.log("--- body (trim) ---\n", body.slice(0, 500));
}

const ips = results.map((r) => {
  const m = r.bodyPreview.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return m ? m[0] : null;
});
console.log("\n=== Summary (parsed IPv4 from body if present) ===");
for (let i = 0; i < results.length; i++) {
  console.log(`${results[i].accId}: ${ips[i] ?? "(no ipv4 in first 200 chars)"}`);
}
if (ips.length >= 2 && ips[0] && ips[1] && ips[0] !== ips[1]) {
  console.log("\nNote: different IPs per account — sticky sessions work as expected.");
} else if (ips.length >= 2 && ips[0] && ips[1] && ips[0] === ips[1]) {
  console.log("\nNote: same IP for both accounts — check zone/session settings if you expected different egress.");
}
