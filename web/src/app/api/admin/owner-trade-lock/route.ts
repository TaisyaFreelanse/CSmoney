/**
 * GET    /api/admin/owner-trade-lock — метаданные списка (admin).
 * PUT    /api/admin/owner-trade-lock — заменить список из JSON или assetIds[].
 * DELETE /api/admin/owner-trade-lock — удалить строку в БД → снова файл/env.
 */
import { NextRequest, NextResponse } from "next/server";

import { Prisma } from "@prisma/client";

import { getSessionUser } from "@/lib/auth";
import {
  buildOwnerLockOnlySnapshotFromParsedJson,
  extractManualTradeLockEntries,
  resolveOwnerManualTradeLockFilePath,
} from "@/lib/owner-manual-trade-lock";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_JSON_CHARS = 25_000_000;

async function assertAdmin() {
  const user = await getSessionUser();
  if (!user?.isAdmin) return null;
  return user;
}

export async function GET() {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const row = await prisma.ownerManualTradeLockList.findUnique({
    where: { id: "singleton" },
  });

  const lockDisplayLen =
    row?.lockDisplayItems != null && Array.isArray(row.lockDisplayItems) ? row.lockDisplayItems.length : 0;

  return NextResponse.json({
    loadedFromDb: !!row,
    assetIdCount: row?.assetIds.length ?? 0,
    classInstanceKeyCount: row?.classInstanceKeys.length ?? 0,
    lockDisplayItemCount: lockDisplayLen,
    /** @deprecated use assetIdCount */
    count: row?.assetIds.length ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    sampleAssetIds: row ? row.assetIds.slice(0, 12) : [],
    sampleClassInstanceKeys: row ? row.classInstanceKeys.slice(0, 12) : [],
    fileFallbackPath: resolveOwnerManualTradeLockFilePath(),
    classInstanceOnlyEnv: process.env.OWNER_MANUAL_TRADE_LOCK_CLASS_INSTANCE_ONLY ?? "",
  });
}

export async function PUT(request: NextRequest) {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { jsonText?: unknown; assetIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let assetIds: string[] = [];
  let classInstanceKeys: string[] = [];
  /** null = clear stored snapshot (assetIds-only save); array = normalized lock rows */
  let lockDisplayPayload: unknown[] | null = null;

  if (typeof body.jsonText === "string") {
    const text = body.jsonText;
    if (text.length > MAX_JSON_CHARS) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const ex = extractManualTradeLockEntries(parsed);
      assetIds = ex.assetIds;
      classInstanceKeys = ex.classInstanceKeys;
      const norm = buildOwnerLockOnlySnapshotFromParsedJson(parsed, process.env.OWNER_STEAM_ID);
      lockDisplayPayload = norm;
    } catch {
      return NextResponse.json({ error: "invalid_json_text" }, { status: 400 });
    }
  } else if (Array.isArray(body.assetIds)) {
    assetIds = body.assetIds.filter((x): x is string => typeof x === "string" && x.length > 0);
    lockDisplayPayload = null;
  } else {
    return NextResponse.json(
      { error: "expected_jsonText_or_assetIds", message: "Передайте jsonText (строка JSON) или assetIds (массив строк)" },
      { status: 400 },
    );
  }

  const uniqueAssetIds = [...new Set(assetIds)];
  const uniqueCi = [...new Set(classInstanceKeys)];

  const row = await prisma.ownerManualTradeLockList.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      assetIds: uniqueAssetIds,
      classInstanceKeys: uniqueCi,
      ...(lockDisplayPayload !== null && {
        lockDisplayItems: lockDisplayPayload as Prisma.InputJsonValue,
      }),
    },
    update: {
      assetIds: uniqueAssetIds,
      classInstanceKeys: uniqueCi,
      lockDisplayItems:
        lockDisplayPayload === null ? Prisma.DbNull : (lockDisplayPayload as Prisma.InputJsonValue),
    },
  });

  const displayCount =
    row.lockDisplayItems != null && Array.isArray(row.lockDisplayItems) ? row.lockDisplayItems.length : 0;

  return NextResponse.json({
    ok: true,
    assetIdCount: row.assetIds.length,
    classInstanceKeyCount: row.classInstanceKeys.length,
    lockDisplayItemCount: displayCount,
    count: row.assetIds.length,
    updatedAt: row.updatedAt.toISOString(),
    message: `Сохранено: ${row.assetIds.length} asset id, ${row.classInstanceKeys.length} пар classid+instanceid; витрина трейдлока: ${displayCount} предметов`,
  });
}

export async function DELETE() {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await prisma.ownerManualTradeLockList.deleteMany({ where: { id: "singleton" } });

  return NextResponse.json({ ok: true, message: "Список в БД удалён; при наличии файла используется он" });
}
