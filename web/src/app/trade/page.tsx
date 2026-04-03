"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  inspectLink: string | null;
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

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

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
  const [editingTradeUrl, setEditingTradeUrl] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Refresh cooldowns (seconds remaining)
  const [ownerRefreshing, setOwnerRefreshing] = useState(false);
  const [myRefreshing, setMyRefreshing] = useState(false);
  const [ownerCooldown, setOwnerCooldown] = useState(0);
  const [myCooldown, setMyCooldown] = useState(0);

  // Selected items for trade
  const [selectedMy, setSelectedMy] = useState<Set<string>>(new Set());
  const [selectedOwner, setSelectedOwner] = useState<Set<string>>(new Set());

  // Independent filters per panel
  const [mySearch, setMySearch] = useState("");
  const [myType, setMyType] = useState("All");
  const [myWear, setMyWear] = useState("All");
  const [mySort, setMySort] = useState("price-desc");

  const [ownerSearch, setOwnerSearch] = useState("");
  const [ownerType, setOwnerType] = useState("All");
  const [ownerWear, setOwnerWear] = useState("All");
  const [ownerSort, setOwnerSort] = useState("price-desc");

  const loadOwner = useCallback(async () => {
    const res = await fetch("/api/inventory/owner");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) {
      setOwnerItems(data.items);
    } else {
      console.error("Owner inventory error:", data);
      setError(data?.message ?? `Инвентарь магазина: ${data?.error ?? "ошибка загрузки"}`);
    }
  }, []);

  const loadMyInventory = useCallback(async () => {
    const res = await fetch("/api/inventory/me");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) {
      setMyItems(data.items);
    } else if (data?.error === "trade_url_required") {
      /* expected */
    } else if (data?.error !== "unauthorized") {
      console.error("My inventory error:", data);
      setError(`Ваш инвентарь: ${data?.error ?? "ошибка загрузки"}`);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadOwner();
      const meRes = await fetch("/api/auth/me");
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData.user) {
          setIsLoggedIn(true);
          const tradeRes = await fetch("/api/profile/trade-url");
          if (tradeRes.ok) {
            const td = await tradeRes.json();
            setHasTradeUrl(td.hasTradeUrl);
            setTradeUrl(td.tradeUrl ?? "");
          }
          await loadMyInventory();
        }
      }
      setLoading(false);
    })();
  }, [loadOwner, loadMyInventory]);

  const saveTradeUrl = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/profile/trade-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeUrl }),
    });
    if (res.ok) {
      setHasTradeUrl(true);
      setEditingTradeUrl(false);
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

  // Cooldown timers
  useEffect(() => {
    if (ownerCooldown <= 0 && myCooldown <= 0) return;
    const t = setInterval(() => {
      setOwnerCooldown((v) => Math.max(0, v - 1));
      setMyCooldown((v) => Math.max(0, v - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [ownerCooldown, myCooldown]);

  const refreshOwner = useCallback(async () => {
    setOwnerRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/inventory/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side: "owner" }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        setOwnerCooldown(Math.ceil((data?.retryAfterMs ?? 120000) / 1000));
      } else if (res.ok) {
        setOwnerCooldown(120);
        await loadOwner();
      } else {
        setError(data?.message ?? data?.error ?? "Ошибка обновления");
      }
    } finally {
      setOwnerRefreshing(false);
    }
  }, [loadOwner]);

  const refreshMy = useCallback(async () => {
    setMyRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/inventory/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side: "my" }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        setMyCooldown(Math.ceil((data?.retryAfterMs ?? 120000) / 1000));
      } else if (res.ok) {
        setMyCooldown(120);
        await loadMyInventory();
      } else {
        setError(data?.message ?? data?.error ?? "Ошибка обновления");
      }
    } finally {
      setMyRefreshing(false);
    }
  }, [loadMyInventory]);

  // Toggle selection
  const toggleMy = useCallback((id: string) => {
    setSelectedMy((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleOwner = useCallback((id: string) => {
    setSelectedOwner((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const removeMySelected = useCallback((id: string) => {
    setSelectedMy((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const removeOwnerSelected = useCallback((id: string) => {
    setSelectedOwner((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Helpers
  const selectedMyItems = myItems.filter((i) => selectedMy.has(i.assetId));
  const selectedOwnerItems = ownerItems.filter((i) => selectedOwner.has(i.assetId));
  const myTotal = selectedMyItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);
  const ownerTotal = selectedOwnerItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);

  function filterAndSort(
    items: InventoryItem[],
    search: string,
    typeFilter: string,
    wearFilter: string,
    sort: string,
  ): InventoryItem[] {
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
        <div className="mx-auto flex max-w-[1600px] items-center justify-between">
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

      {/* Trade Offer Panels */}
      <div className="border-b border-zinc-800 bg-zinc-900/40">
        <div className="mx-auto grid max-w-[1600px] grid-cols-2 gap-0">
          {/* Your offer */}
          <TradeOfferPanel
            title="Вы отдаёте"
            items={selectedMyItems}
            total={myTotal}
            onRemove={removeMySelected}
            emptyText={isLoggedIn ? "Выберите предметы из вашего инвентаря" : "Войдите через Steam"}
          />
          {/* You receive */}
          <TradeOfferPanel
            title="Вы получаете"
            items={selectedOwnerItems}
            total={ownerTotal}
            onRemove={removeOwnerSelected}
            emptyText="Выберите предметы из инвентаря магазина"
            isRight
          />
        </div>
      </div>

      {error && (
        <div className="mx-auto max-w-[1600px] px-4 pt-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Two-panel inventory layout */}
      <div className="mx-auto max-w-[1600px] px-4 py-4">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Left: My items (guest) */}
          <div className="flex flex-col">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
                Ваш инвентарь
              </h2>
              <div className="flex items-center gap-2">
                {isLoggedIn && hasTradeUrl && !editingTradeUrl && (
                  <>
                    <button
                      onClick={() => setEditingTradeUrl(true)}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300"
                    >
                      Изменить trade-ссылку
                    </button>
                    <RefreshButton
                      onClick={refreshMy}
                      loading={myRefreshing}
                      cooldown={myCooldown}
                    />
                  </>
                )}
              </div>
            </div>

            {!isLoggedIn ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
                <a href="/api/auth/steam" className="text-blue-400 hover:underline">
                  Войдите через Steam
                </a>{" "}
                чтобы увидеть свой инвентарь
              </div>
            ) : !hasTradeUrl || editingTradeUrl ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
                <p className="mb-3 text-sm text-zinc-400">
                  {hasTradeUrl
                    ? "Обновите вашу trade-ссылку:"
                    : "Вставьте вашу trade-ссылку из Steam для загрузки инвентаря:"}
                </p>
                <p className="mb-3 text-[11px] text-zinc-600">
                  Найти можно здесь:{" "}
                  <a
                    href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    Настройки приватности Steam
                  </a>
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
                  {hasTradeUrl && (
                    <button
                      onClick={() => setEditingTradeUrl(false)}
                      className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100"
                    >
                      Отмена
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <FilterBar
                  search={mySearch}
                  onSearch={setMySearch}
                  type={myType}
                  onType={setMyType}
                  wear={myWear}
                  onWear={setMyWear}
                  sort={mySort}
                  onSort={setMySort}
                  prefix="my"
                />
                <ItemGrid
                  items={filterAndSort(myItems, mySearch, myType, myWear, mySort)}
                  side="guest"
                  selected={selectedMy}
                  onToggle={toggleMy}
                />
              </>
            )}
          </div>

          {/* Right: Owner items */}
          <div className="flex flex-col">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
                Инвентарь магазина
              </h2>
              <RefreshButton
                onClick={refreshOwner}
                loading={ownerRefreshing}
                cooldown={ownerCooldown}
              />
            </div>
            <FilterBar
              search={ownerSearch}
              onSearch={setOwnerSearch}
              type={ownerType}
              onType={setOwnerType}
              wear={ownerWear}
              onWear={setOwnerWear}
              sort={ownerSort}
              onSort={setOwnerSort}
              prefix="owner"
            />
            <ItemGrid
              items={filterAndSort(ownerItems, ownerSearch, ownerType, ownerWear, ownerSort)}
              side="owner"
              selected={selectedOwner}
              onToggle={toggleOwner}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trade Offer Panel (top section showing selected items)
// ---------------------------------------------------------------------------

function TradeOfferPanel({
  title,
  items,
  total,
  onRemove,
  emptyText,
  isRight,
}: {
  title: string;
  items: InventoryItem[];
  total: number;
  onRemove: (id: string) => void;
  emptyText: string;
  isRight?: boolean;
}) {
  return (
    <div className={`border-zinc-800 px-4 py-3 ${isRight ? "border-l" : ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </h3>
        {total > 0 && (
          <span className="text-xs font-semibold text-emerald-400">
            {formatPrice(total)}
          </span>
        )}
      </div>
      <div className="flex min-h-[72px] items-start gap-1.5 overflow-x-auto pb-1">
        {items.length === 0 ? (
          <p className="self-center text-xs text-zinc-600">{emptyText}</p>
        ) : (
          items.map((item) => (
            <div
              key={item.assetId}
              className="group relative flex-shrink-0"
              title={`${item.name} — ${item.priceUsd > 0 ? formatPrice(item.priceUsd) : "—"}`}
            >
              <div className="relative h-14 w-14 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800 p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.iconUrl}
                  alt={item.name}
                  className="h-full w-full object-contain"
                />
                <button
                  onClick={() => onRemove(item.assetId)}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
              {item.priceUsd > 0 && !item.belowThreshold && (
                <p className="mt-0.5 text-center text-[9px] text-emerald-400">
                  {formatPrice(item.priceUsd)}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar (per-panel)
// ---------------------------------------------------------------------------

function FilterBar({
  search,
  onSearch,
  type,
  onType,
  wear,
  onWear,
  sort,
  onSort,
  prefix,
}: {
  search: string;
  onSearch: (v: string) => void;
  type: string;
  onType: (v: string) => void;
  wear: string;
  onWear: (v: string) => void;
  sort: string;
  onSort: (v: string) => void;
  prefix: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <input
        type="text"
        placeholder="Поиск..."
        className="w-36 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <select
        aria-label={`${prefix}-type`}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100"
        value={type}
        onChange={(e) => onType(e.target.value)}
      >
        {ITEM_TYPES.map((t) => (
          <option key={t} value={t}>
            {t === "All" ? "Все типы" : t}
          </option>
        ))}
      </select>
      <select
        aria-label={`${prefix}-wear`}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100"
        value={wear}
        onChange={(e) => onWear(e.target.value)}
      >
        <option value="All">Все износы</option>
        {WEAR_LABELS.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
      <select
        aria-label={`${prefix}-sort`}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100"
        value={sort}
        onChange={(e) => onSort(e.target.value)}
      >
        {SORT_OPTIONS.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Refresh button with cooldown
// ---------------------------------------------------------------------------

function RefreshButton({
  onClick,
  loading,
  cooldown,
}: {
  onClick: () => void;
  loading: boolean;
  cooldown: number;
}) {
  const disabled = loading || cooldown > 0;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        disabled
          ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      }`}
      title={cooldown > 0 ? `Доступно через ${cooldown} сек.` : "Обновить инвентарь"}
    >
      <span className={loading ? "animate-spin" : ""}>↻</span>
      {cooldown > 0 ? `${cooldown}с` : "Обновить"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Item grid
// ---------------------------------------------------------------------------

function ItemGrid({
  items,
  side,
  selected,
  onToggle,
}: {
  items: InventoryItem[];
  side: "owner" | "guest";
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
        Нет предметов
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
      {items.map((item) => (
        <ItemCard
          key={`${side}-${item.assetId}`}
          item={item}
          isSelected={selected.has(item.assetId)}
          onToggle={() => onToggle(item.assetId)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function RarityAccentStripe({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--trade-item-rarity", color);
  }, [color]);
  return (
    <div
      ref={ref}
      className="trade-item-rarity-accent absolute inset-x-0 top-0 h-0.5"
    />
  );
}

function ItemCard({
  item,
  isSelected,
  onToggle,
}: {
  item: InventoryItem;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const isLocked = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date();
  const isUnavailable = item.belowThreshold && item.priceSource !== "manual";
  const disabled = isLocked || isUnavailable;

  return (
    <div
      onClick={disabled ? undefined : onToggle}
      className={`relative overflow-hidden rounded-xl border bg-zinc-900 transition-all ${
        disabled
          ? "border-zinc-800 opacity-60"
          : isSelected
            ? "border-emerald-500 ring-1 ring-emerald-500/50 cursor-pointer"
            : "border-zinc-700 hover:border-zinc-500 cursor-pointer"
      }`}
    >
      {item.rarityColor && <RarityAccentStripe color={item.rarityColor} />}

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute left-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white">
          ✓
        </div>
      )}

      {/* Image */}
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

        {item.phaseLabel && (
          <p className="text-[10px] font-semibold text-cyan-400">{item.phaseLabel}</p>
        )}

        {item.wear && (
          <p className="text-[10px] text-zinc-500">
            {item.wear}
            {item.floatValue != null && ` · ${item.floatValue.toFixed(4)}`}
          </p>
        )}

        <div className="flex items-center justify-between pt-0.5">
          {item.priceSource === "unavailable" || isUnavailable ? (
            <span className="text-[10px] font-medium text-zinc-500">—</span>
          ) : (
            <span className="text-xs font-semibold text-emerald-400">
              {formatPrice(item.priceUsd)}
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
