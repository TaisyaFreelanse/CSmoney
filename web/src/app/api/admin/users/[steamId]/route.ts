import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ steamId: string }> },
) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { steamId } = await context.params;
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let body: { isBanned?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.isBanned !== "boolean") {
    return NextResponse.json({ error: "is_banned_required" }, { status: 400 });
  }

  if (body.isBanned && steamId === admin.steamId) {
    return NextResponse.json({ error: "cannot_ban_self" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { steamId } });
  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await prisma.user.update({
    where: { steamId },
    data: { isBanned: body.isBanned },
    select: {
      steamId: true,
      displayName: true,
      isBanned: true,
      isAdmin: true,
    },
  });

  return NextResponse.json({ ok: true, user: updated });
}
