#!/usr/bin/env node
/**
 * One-off: does merged `raw` contain asset id? Usage:
 *   cd steam-worker && node --env-file=.env scripts/check-raw-asset.mjs [assetId]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const assetId = process.argv[2]?.trim() || "51178755989";
const tradeUrl =
  process.argv[3]?.trim() ||
  process.env.TRADE_VERIFY_URL?.trim() ||
  "https://steamcommunity.com/tradeoffer/new/?partner=344919981&token=s3lHfh8l";
const port = Number(process.env.PORT) || 3001;
const base = `http://127.0.0.1:${port}`;
const u = new URL("/inventory", base);
u.searchParams.set("tradeUrl", tradeUrl);
const headers = {};
if (process.env.API_KEY?.trim()) headers["x-api-key"] = process.env.API_KEY.trim();

const res = await fetch(u, { headers });
const j = await res.json().catch(() => ({}));
const raw = j.raw;
const assets = Array.isArray(raw?.assets) ? raw.assets : [];
const inArr = assets.some((a) => String(a.assetid ?? a.id) === assetId);
let inRg = false;
const rg = raw?.rgInventory;
if (rg && typeof rg === "object") {
  for (const row of Object.values(rg)) {
    if (row && typeof row === "object" && (String(row.id) === assetId || String(row.assetid) === assetId)) {
      inRg = true;
      break;
    }
  }
}
const rowArr = assets.find((a) => String(a.assetid ?? a.id) === assetId) ?? null;
const cid = rowArr ? String(rowArr.classid ?? "") : "";
const descs = Array.isArray(raw?.descriptions) ? raw.descriptions : [];
const descKeysForClass = cid
  ? descs
      .filter((d) => d && String(d.classid) === cid)
      .map((d) => `${d.classid}_${d.instanceid ?? "0"}`)
  : [];

console.log(
  JSON.stringify(
    {
      httpOk: res.ok,
      assetId,
      inRawAssetsArray: inArr,
      inRgInventory: inRg,
      rawAssetRow: rowArr,
      descKeysSameClassid: descKeysForClass.slice(0, 30),
      itemsLen: j.items?.length ?? 0,
      lockListHas: Array.isArray(j.itemsFromTradeLock) && j.itemsFromTradeLock.some((x) => String(x.assetid) === assetId),
    },
    null,
    2,
  ),
);
