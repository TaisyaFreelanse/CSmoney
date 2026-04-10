import type { User } from "@prisma/client";

import { normalizeSteamId64ForCache, parseTradeUrl, trySteamId64FromPartner } from "@/lib/steam-inventory";

export type GuestInventoryActor = Pick<User, "steamId" | "tradeUrl">;

export type GuestTradeUrlResolution =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "shop_owner" }
  | { kind: "ok"; derivedSteamId: string };

/** Сообщение для API, если partner в ссылке — владелец магазина (guest не может совпадать с owner). */
export const TRADE_URL_SHOP_OWNER_MESSAGE =
  "Эта ссылка ведёт на инвентарь магазина. Укажите свою trade-ссылку — ваша сторона обмена не может совпадать с владельцем." as const;

function normalizedOwnerSteamId(): string | null {
  const o = process.env.OWNER_STEAM_ID?.trim();
  if (!o || o.length === 0) return null;
  return normalizeSteamId64ForCache(o);
}

/**
 * Разбор trade URL для гостевого инвентаря: нельзя использовать ссылку на OWNER_STEAM_ID
 * (кэш, цены и UI ломаются при guest === owner).
 */
export function resolveGuestTradeUrl(user: GuestInventoryActor): GuestTradeUrlResolution {
  if (!user.tradeUrl?.trim()) return { kind: "none" };
  const parsed = parseTradeUrl(user.tradeUrl.trim());
  if (!parsed) return { kind: "invalid" };
  const derivedRaw = trySteamId64FromPartner(parsed.partner);
  if (!derivedRaw) return { kind: "invalid" };
  const derivedSteamId = normalizeSteamId64ForCache(derivedRaw);
  const owner = normalizedOwnerSteamId();
  if (owner && derivedSteamId === owner) return { kind: "shop_owner" };
  return { kind: "ok", derivedSteamId };
}

/**
 * SteamID64 владельца инвентаря по сохранённой trade URL (partner → SteamID64).
 * Если URL есть и парсится — `derivedSteamId`, никогда `user.steamId`.
 * Ссылка на инвентарь магазина (OWNER_STEAM_ID) не считается валидной для гостя.
 */
export function resolveGuestInventoryTargetSteamId(user: GuestInventoryActor): string | null {
  const r = resolveGuestTradeUrl(user);
  return r.kind === "ok" ? r.derivedSteamId : null;
}

/**
 * Админ с сохранённой trade URL на другой Steam (partner ≠ сессия): целевой инвентарь — derivedSteamId,
 * без блокировок «не ваша ссылка» и без лишней инвалидации кэша по session SteamID.
 */
export function adminGuestOwnershipMismatch(user: Pick<User, "steamId" | "tradeUrl" | "isAdmin">): boolean {
  if (user.isAdmin !== true) return false;
  const target = resolveGuestInventoryTargetSteamId(user);
  if (!target) return false;
  return normalizeSteamId64ForCache(user.steamId) !== target;
}

/** Если в профиле есть trade URL, но он не даёт валидного гостевого инвентаря — код и текст для 400. */
export function guestTradeUrlHttpRejection(user: GuestInventoryActor): {
  error: string;
  message: string;
} | null {
  if (!user.tradeUrl?.trim()) return null;
  const r = resolveGuestTradeUrl(user);
  if (r.kind === "shop_owner") {
    return { error: "trade_url_shop_owner", message: TRADE_URL_SHOP_OWNER_MESSAGE };
  }
  if (r.kind === "invalid") {
    return {
      error: "invalid_trade_url",
      message: "Сохранённая trade-ссылка некорректна. Укажите ссылку заново.",
    };
  }
  return null;
}

/** Защита на случай рассинхрона env / старого кэша. */
export function warnIfGuestSteamIdEqualsOwner(context: string, guestSteamId: string | null): void {
  const owner = normalizedOwnerSteamId();
  if (!guestSteamId || !owner) return;
  if (guestSteamId === owner) {
    console.warn(`[${context}] guest == owner BUG: derived guestSteamId matches OWNER_STEAM_ID`, {
      guestSteamId,
    });
  }
}
