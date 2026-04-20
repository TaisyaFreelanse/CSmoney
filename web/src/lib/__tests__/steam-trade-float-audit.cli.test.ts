/**
 * CLI-style audit on a saved partnerinventory / merged JSON file.
 *
 * PowerShell:
 *   $env:AUDIT_TRADE_INV_JSON = "C:\path\to\partnerinventory.json"
 *   npm run audit:trade-float
 *
 * Bash:
 *   AUDIT_TRADE_INV_JSON=./snap.json npm run audit:trade-float
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { auditSteamInventoryFloatCoverage } from "../steam-inventory";

const jsonPath = process.env.AUDIT_TRADE_INV_JSON?.trim() ?? "";
const runCli = jsonPath.length > 0 && existsSync(jsonPath);

describe.skipIf(!runCli)("steam trade inventory float audit (AUDIT_TRADE_INV_JSON)", () => {
  it("prints JSON report to stdout", () => {
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8")) as unknown;
    const report = auditSteamInventoryFloatCoverage(raw);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    expect(report.total).toBeGreaterThan(0);
  });
});
