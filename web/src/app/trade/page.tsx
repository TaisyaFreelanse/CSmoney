"use client";

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Sticker {
  name: string;
  iconUrl: string;
}

interface InventoryItem {
  assetId: string;
  classId: string;
  instanceId: string;
  marketHashName: string;
  name: string;
  iconUrl: string;
  rarity: string | null;
  rarityColor: string | null;
  type: string | null;
  wear: string | null;
  floatValue: number | null;
  phaseLabel: string | null;
  stickers: Sticker[];
  tradeLockUntil: string | null;
  tradable: boolean;
  marketable: boolean;
  priceUsd: number;
  priceSource: "catalog" | "manual" | "unavailable";
  belowThreshold: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITEM_TYPES = [
  "All",
  "Rifle",
  "Pistol",
  "SMG",
  "Shotgun",
  "Machine Gun",
  "Knife",
  "Gloves",
  "Agent",
  "Sticker",
  "Graffiti",
  "Music Kit",
  "Patch",
  "Key",
  "Container",
  "Charm",
] as const;

const WEAR_LABELS = [
  "Factory New",
  "Minimal Wear",
  "Field-Tested",
  "Well-Worn",
  "Battle-Scarred",
] as const;

const SORT_OPTIONS = [
  { key: "price-desc", label: "Цена ↓" },
  { key: "price-asc", label: "Цена ↑" },
  { key: "name-asc", label: "Имя A→Z" },
  { key: "name-desc", label: "Имя Z→A" },
  { key: "float-asc", label: "Float ↑" },
  { key: "float-desc", label: "Float ↓" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TradePage() {
  const [ownerItems, setOwnerItems] = useState<InventoryItem[]>([]);
  const [myItems, setMyItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tradeUrl, setTradeUrl] = useState("");
  const [hasTradeUrl, setHasTradeUrl] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Filters — shared between both panels
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [wearFilter, setWearFilter] = useState("All");
  const [sort, setSort] = useState("price-desc");

  useEffect(() => {
    (async () => {
      // Load owner inventory (public)
      const ownerRes = await fetch("/api/inventory/owner");
      if (ownerRes.ok) {
        const data = await ownerRes.json();
        setOwnerItems(data.items ?? []);
      }

      // Check auth
      const meRes = await fetch("/api/auth/me");
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.user) {
          setIsLoggedIn(true);
          // Load trade url status
          const tradeRes = await fetch("/api/profile/trade-url");
          if (tradeRes.ok) {
            const td = await tradeRes.json();
            setHasTradeUrl(td.hasTradeUrl);
            setTradeUrl(td.tradeUrl ?? "");
          }
          // Load my inventory
          const myRes = await fetch("/api/inventory/me");
          if (myRes.ok) {
            const myData = await myRes.json();
            setMyItems(myData.items ?? []);
          } else {
            const err = await myRes.json().catch(() => null);
            if (err?.error === "trade_url_required") {
              setError(null);
            }
          }
        }
      }
      setLoading(false);
    })();
  }, []);

  const saveTradeUrl = useCallback(async () => {
    const res = await fetch("/api/profile/trade-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeUrl }),
    });
    if (res.ok) {
      setHasTradeUrl(true);
      // Reload inventory
      const myRes = await fetch("/api/inventory/me");
      if (myRes.ok) {
        const data = await myRes.json();
        setMyItems(data.items ?? []);
      }
    } else {
      const err = await res.json().catch(() => null);
      setError(err?.message ?? "Ошибка сохранения trade-ссылки");
    }
  }, [tradeUrl]);

  function filterAndSort(items: InventoryItem[]): InventoryItem[] {
    let result = items;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.marketHashName.toLowerCase().includes(q),
      );
    }

    if (typeFilter !== "All") {
      result = result.filter((i) => i.type?.includes(typeFilter));
    }

    if (wearFilter !== "All") {
      result = result.filter((i) => i.wear === wearFilter);
    }

    result = [...result].sort((a, b) => {
      switch (sort) {
        case "price-desc":
          return b.priceUsd - a.priceUsd;
        case "price-asc":
          return a.priceUsd - b.priceUsd;
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "float-asc":
          return (a.floatValue ?? 1) - (b.floatValue ?? 1);
        case "float-desc":
          return (b.floatValue ?? 0) - (a.floatValue ?? 0);
        default:
          return 0;
      }
    });

    return result;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Загрузка инвентарей...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <a href="/" className="text-lg font-bold tracking-tight">
            CS2 Trade
          </a>
          {!isLoggedIn && (
            <a
              href="/api/auth/steam"
              className="rounded-lg bg-[#171a21] px-4 py-2 text-sm font-medium text-white hover:bg-[#2a475e]"
            >
              Войти через Steam
            </a>
          )}
        </div>
      </header>

      {/* Filters bar */}
      <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Поиск..."
            className="w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Тип предмета"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "All" ? "Все типы" : t}
              </option>
            ))}
          </select>
          <select
            aria-label="Износ"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
            value={wearFilter}
            onChange={(e) => setWearFilter(e.target.value)}
          >
            <option value="All">Все износы</option>
            {WEAR_LABELS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <select
            aria-label="Сортировка"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mx-auto max-w-7xl px-4 pt-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Two-panel layout */}
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: My items (guest) */}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Ваш инвентарь
            </h2>
            {!isLoggedIn ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
                <a href="/api/auth/steam" className="text-blue-400 hover:underline">
                  Войдите через Steam
                </a>{" "}
                чтобы увидеть свой инвентарь
              </div>
            ) : !hasTradeUrl ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                <p className="mb-3 text-sm text-zinc-400">
                  Вставьте вашу trade-ссылку из Steam для загрузки инвентаря:
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500"
                    value={tradeUrl}
                    onChange={(e) => setTradeUrl(e.target.value)}
                  />
                  <button
                    onClick={saveTradeUrl}
                    className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-300"
                  >
                    Сохранить
                  </button>
                </div>
              </div>
            ) : (
              <ItemGrid items={filterAndSort(myItems)} side="guest" />
            )}
          </div>

          {/* Right: Owner items */}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Инвентарь магазина
            </h2>
            <ItemGrid items={filterAndSort(ownerItems)} side="owner" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item grid
// ---------------------------------------------------------------------------

function ItemGrid({
  items,
  side,
}: {
  items: InventoryItem[];
  side: "owner" | "guest";
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
        Нет предметов
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {items.map((item) => (
        <ItemCard key={`${side}-${item.assetId}`} item={item} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function ItemCard({ item }: { item: InventoryItem }) {
  const isLocked = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date();
  const isUnavailable = item.belowThreshold && item.priceSource !== "manual";
  const disabled = isLocked || isUnavailable;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-zinc-900 transition-colors ${
        disabled
          ? "border-zinc-800 opacity-70"
          : "border-zinc-700 hover:border-zinc-500 cursor-pointer"
      }`}
    >
      {/* Rarity accent */}
      {item.rarityColor && (
        <div
          className="absolute inset-x-0 top-0 h-0.5"
          style={{ backgroundColor: item.rarityColor }}
        />
      )}

      {/* Image / blur for unavailable */}
      <div className="relative flex items-center justify-center bg-zinc-800/50 p-3">
        {isUnavailable ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.iconUrl}
              alt=""
              className="h-20 w-20 object-contain blur-sm"
              loading="lazy"
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="rounded bg-zinc-900/80 px-2 py-1 text-center text-[10px] font-medium uppercase leading-tight text-zinc-400">
                UNAVAILABLE
                <br />
                Price too low
              </span>
            </div>
          </>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={item.iconUrl}
            alt={item.name}
            className="h-20 w-20 object-contain"
            loading="lazy"
          />
        )}

        {/* Trade lock badge */}
        {isLocked && (
          <div className="absolute right-1 top-1 rounded bg-orange-600/80 px-1.5 py-0.5 text-[9px] font-medium text-white">
            {formatTradeLock(item.tradeLockUntil!)}
          </div>
        )}

        {/* Stickers */}
        {item.stickers.length > 0 && (
          <div className="absolute bottom-1 left-1 flex gap-0.5">
            {item.stickers.map((s, i) => (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={i}
                src={s.iconUrl}
                alt={s.name}
                title={s.name}
                className="h-4 w-4 rounded-sm"
                loading="lazy"
              />
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="space-y-0.5 px-2 pb-2 pt-1.5">
        <p className="truncate text-xs font-medium text-zinc-100" title={item.name}>
          {item.name}
        </p>

        {/* Phase label */}
        {item.phaseLabel && (
          <p className="text-[10px] font-semibold text-cyan-400">{item.phaseLabel}</p>
        )}

        {/* Wear + float */}
        {item.wear && (
          <p className="text-[10px] text-zinc-500">
            {item.wear}
            {item.floatValue != null && ` · ${item.floatValue.toFixed(4)}`}
          </p>
        )}

        {/* Price */}
        <div className="flex items-center justify-between pt-0.5">
          {item.priceSource === "unavailable" || isUnavailable ? (
            <span className="text-[10px] font-medium text-zinc-500">—</span>
          ) : (
            <span className="text-xs font-semibold text-emerald-400">
              ${(item.priceUsd / 100).toFixed(2)}
            </span>
          )}
          {item.priceSource === "manual" && (
            <span className="text-[9px] text-amber-500">manual</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTradeLock(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return "";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}д ${hours}ч`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}ч ${mins}м`;
}
