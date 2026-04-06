import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

/** Admin-only list of users (includes tradeUrl for support). */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      steamId: true,
      displayName: true,
      tradeUrl: true,
      createdAt: true,
      lastLoginAt: true,
      isBanned: true,
      isAdmin: true,
    },
  });

  const users = rows.map((u) => ({
    ...u,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  }));

  return NextResponse.json({ users });
}
