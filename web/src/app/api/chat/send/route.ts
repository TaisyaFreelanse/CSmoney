import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import {
  assertUserCanSend,
  CHAT_SENDER,
  getOrCreateConversation,
  normalizeChatText,
  serializeChatMessage,
} from "@/lib/chat";
import { prisma } from "@/lib/prisma";
import { queueTelegramSupportUserMessage } from "@/lib/telegram-notify";

export const dynamic = "force-dynamic";

/** POST /api/chat/send — body: { text } */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const text = normalizeChatText(
    typeof body === "object" && body !== null && "text" in body
      ? (body as { text: unknown }).text
      : null,
  );
  if (!text) {
    return NextResponse.json({ error: "invalid_text" }, { status: 400 });
  }

  const rate = await assertUserCanSend(user.steamId);
  if (!rate.ok) {
    return NextResponse.json({ error: rate.error }, { status: rate.status });
  }

  const conv = await getOrCreateConversation(user.steamId);

  const msg = await prisma.chatMessage.create({
    data: {
      conversationId: conv.id,
      sender: CHAT_SENDER.user,
      text,
      isRead: false,
    },
  });

  await prisma.chatConversation.update({
    where: { id: conv.id },
    data: { updatedAt: new Date() },
  });

  queueTelegramSupportUserMessage(
    { steamId: user.steamId, displayName: user.displayName },
    msg,
  );

  return NextResponse.json({ message: serializeChatMessage(msg) });
}
