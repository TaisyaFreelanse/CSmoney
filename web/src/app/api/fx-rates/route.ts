/**
 * GET /api/fx-rates — public USD→display currency rates (from DB cache or static fallback).
 */
import { NextResponse } from "next/server";

import { getFxRatesPayload } from "@/lib/exchange-rates-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getFxRatesPayload();
  return NextResponse.json(payload);
}
