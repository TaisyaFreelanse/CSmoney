"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatRefreshCooldownRu, OWNER_REFRESH_COOLDOWN_MS, USER_REFRESH_COOLDOWN_MS } from "@/lib/inventory-refresh-limits";
import {
  checkTradeBalance,
  MAX_TRADE_ITEMS_PER_SIDE,
  TRADE_MAX_OVERPAY_PERCENT,
  tradeOverpayPercent,
} from "@/lib/trade-balance";

import styles from "./page.module.css";

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

const ITEM_CATEGORIES = [
  { key: "All", label: "Все предметы", icon: "◈" },
  { key: "Weapon", label: "Скины оружия", icon: "🎯" },
  { key: "Knife", label: "Ножи", icon: "🔪" },
  { key: "Gloves", label: "Перчатки", icon: "🧤" },
  { key: "Sticker", label: "Стикеры", icon: "🏷" },
  { key: "Graffiti", label: "Граффити", icon: "🎨" },
  { key: "Agent", label: "Агенты", icon: "🕵" },
  { key: "Music Kit", label: "Муз. наборы", icon: "🎵" },
  { key: "Patch", label: "Нашивки", icon: "🛡" },
  { key: "Charm", label: "Брелоки", icon: "🔑" },
  { key: "Container", label: "Кейсы", icon: "📦" },
] as const;

const WEAPON_TYPES = ["Rifle", "Pistol", "SMG", "Shotgun", "Machine Gun"] as const;

const WEAR_LABELS = [
  "Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred",
] as const;

const WEAR_SHORT: Record<string, string> = {
  "Factory New": "FN",
  "Minimal Wear": "MW",
  "Field-Tested": "FT",
  "Well-Worn": "WW",
  "Battle-Scarred": "BS",
};

const SORT_OPTIONS = [
  { key: "price-desc", label: "Цена: по убыванию" },
  { key: "price-asc", label: "Цена: по возрастанию" },
  { key: "name-asc", label: "Имя: A→Z" },
  { key: "name-desc", label: "Имя: Z→A" },
  { key: "float-asc", label: "Float ↑" },
  { key: "float-desc", label: "Float ↓" },
] as const;

function fmtPrice(cents: number) {
  return `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} $`;
}

function ruRequirementsHeading(pending: number): string {
  if (pending <= 0) return "";
  const m10 = pending % 10;
  const m100 = pending % 100;
  if (m10 === 1 && m100 !== 11) return `Осталось ${pending} требование`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `Осталось ${pending} требования`;
  return `Осталось ${pending} требований`;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function TradePageClient({
  authError = null,
  signedInNotice = false,
  isAdmin = false,
}: {
  authError?: string | null;
  signedInNotice?: boolean;
  isAdmin?: boolean;
} = {}) {
  const [ownerItems, setOwnerItems] = useState<InventoryItem[]>([]);
  const [myItems, setMyItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tradeSubmitError, setTradeSubmitError] = useState<string | null>(null);
  const [tradeUrl, setTradeUrl] = useState("");
  const [hasTradeUrl, setHasTradeUrl] = useState(false);
  const [editingTradeUrl, setEditingTradeUrl] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);

  const [ownerRefreshing, setOwnerRefreshing] = useState(false);
  const [myRefreshing, setMyRefreshing] = useState(false);
  const [ownerCooldown, setOwnerCooldown] = useState(0);
  const [myCooldown, setMyCooldown] = useState(0);

  const [selectedMy, setSelectedMy] = useState<Set<string>>(new Set());
  const [selectedOwner, setSelectedOwner] = useState<Set<string>>(new Set());
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  // Per-panel search/sort
  const [mySearch, setMySearch] = useState("");
  const [mySort, setMySort] = useState("price-desc");
  const [ownerSearch, setOwnerSearch] = useState("");
  const [ownerSort, setOwnerSort] = useState("price-desc");

  // Center filters (apply to both panels)
  const [category, setCategory] = useState("All");
  const [wear, setWear] = useState("All");

  // ------ loaders ------
  const loadOwner = useCallback(async () => {
    const res = await fetch("/api/inventory/owner");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) {
      setOwnerItems(data.items);
      if (typeof data.refreshCooldownRemainingMs === "number" && data.refreshCooldownRemainingMs > 0) {
        setOwnerCooldown(Math.ceil(data.refreshCooldownRemainingMs / 1000));
      }
    } else setError(data?.message ?? `Магазин: ${data?.error ?? "ошибка"}`);
  }, []);

  const loadMyInventory = useCallback(async () => {
    const res = await fetch("/api/inventory/me");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) {
      setMyItems(data.items);
      if (typeof data.refreshCooldownRemainingMs === "number" && data.refreshCooldownRemainingMs > 0) {
        setMyCooldown(Math.ceil(data.refreshCooldownRemainingMs / 1000));
      }
    } else if (data?.error !== "trade_url_required" && data?.error !== "unauthorized")
      setError(`Инвентарь: ${data?.error ?? "ошибка"}`);
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
        const d = await myRes.json();
        setMyItems(d.items ?? []);
        if (typeof d.refreshCooldownRemainingMs === "number" && d.refreshCooldownRemainingMs > 0) {
          setMyCooldown(Math.ceil(d.refreshCooldownRemainingMs / 1000));
        }
      }
    } else {
      const err = await res.json().catch(() => null);
      setError(err?.message ?? "Ошибка сохранения trade-ссылки");
    }
  }, [tradeUrl]);

  // ------ cooldown ------
  useEffect(() => {
    setTradeSubmitError(null);
  }, [selectedMy, selectedOwner]);

  useEffect(() => {
    if (ownerCooldown <= 0 && myCooldown <= 0) return;
    const t = setInterval(() => {
      setOwnerCooldown((v) => Math.max(0, v - 1));
      setMyCooldown((v) => Math.max(0, v - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [ownerCooldown, myCooldown]);

  const doRefresh = useCallback(async (side: "owner" | "my", setR: (b: boolean) => void, setC: (n: number) => void, reload: () => Promise<void>) => {
    setR(true); setError(null);
    try {
      const res = await fetch("/api/inventory/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side }) });
      const data = await res.json().catch(() => null);
      if (res.status === 429) setC(Math.ceil((data?.retryAfterMs ?? 0) / 1000));
      else if (res.ok) {
        const fallback = side === "my" ? USER_REFRESH_COOLDOWN_MS : OWNER_REFRESH_COOLDOWN_MS;
        const ms = typeof data?.refreshCooldownRemainingMs === "number" ? data.refreshCooldownRemainingMs : fallback;
        setC(Math.ceil(ms / 1000));
        await reload();
      } else setError(data?.message ?? "Ошибка обновления");
    } finally { setR(false); }
  }, []);

  // ------ selection (max MAX_TRADE_ITEMS_PER_SIDE per side) ------
  const toggle = useCallback((set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    set((prev) => {
      if (prev.has(id)) {
        const n = new Set(prev);
        n.delete(id);
        return n;
      }
      if (prev.size >= MAX_TRADE_ITEMS_PER_SIDE) {
        queueMicrotask(() => {
          setSelectionNotice(`Не более ${MAX_TRADE_ITEMS_PER_SIDE} предметов с одной стороны`);
          window.setTimeout(() => setSelectionNotice(null), 2800);
        });
        return prev;
      }
      const n = new Set(prev);
      n.add(id);
      return n;
    });
  }, []);

  // ------ submit trade ------
  const submitTrade = useCallback(async () => {
    setError(null);
    setTradeSubmitError(null);
    setTradeSuccess(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestItems: Array.from(selectedMy), ownerItems: Array.from(selectedOwner) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTradeSubmitError(data?.message ?? data?.error ?? "Ошибка");
        return;
      }
      setTradeSuccess(`Заявка #${data.tradeId} создана!`);
      setSelectedMy(new Set()); setSelectedOwner(new Set());
      if (data.ownerTradeUrl) window.open(data.ownerTradeUrl, "_blank");
    } finally { setSubmitting(false); }
  }, [selectedMy, selectedOwner]);

  // ------ computed ------
  const selMyItems = myItems.filter((i) => selectedMy.has(i.assetId));
  const selOwnerItems = ownerItems.filter((i) => selectedOwner.has(i.assetId));
  const myTotal = selMyItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);
  const ownerTotal = selOwnerItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);
  const tradeSelectionReady = selectedMy.size > 0 && selectedOwner.size > 0;
  const tradeBalance = tradeSelectionReady ? checkTradeBalance(myTotal, ownerTotal) : null;
  const overpayPct = ownerTotal > 0 ? tradeOverpayPercent(myTotal, ownerTotal) ?? 0 : 0;
  const overpayBarFillPct =
    ownerTotal <= 0 ? 0 : overpayPct < 0 ? 0 : Math.min(100, (overpayPct / TRADE_MAX_OVERPAY_PERCENT) * 100);
  const overpayBarColor =
    overpayPct < 0 ? "#f97316" : overpayPct > TRADE_MAX_OVERPAY_PERCENT ? "#ef4444" : "#22c55e";
  const overpayWordColor =
    overpayPct < 0 || overpayPct > TRADE_MAX_OVERPAY_PERCENT
      ? "text-red-400"
      : "text-emerald-500";
  const canSubmit = tradeSelectionReady && tradeBalance?.ok === true && !submitting;

  const requirementRows: { done: boolean; text: string; issue?: boolean }[] = [
    { done: selectedMy.size > 0, text: "Добавьте ваши предметы" },
    { done: selectedOwner.size > 0, text: "Выберите предметы магазина" },
  ];
  if (tradeBalance && !tradeBalance.ok) {
    if (tradeBalance.reason === "overpay_too_high") {
      requirementRows.push({
        done: false,
        issue: true,
        text: `Уменьшите переплату на ${fmtPrice(tradeBalance.excessCents)} (макс. ${TRADE_MAX_OVERPAY_PERCENT}%)`,
      });
    } else if (tradeBalance.reason === "overpay_too_low") {
      requirementRows.push({
        done: false,
        issue: true,
        text: `Добавьте предметы с вашей стороны или уберите с нашей на ${fmtPrice(tradeBalance.shortfallCents)} (переплата не ниже 0%)`,
      });
    } else {
      requirementRows.push({ done: false, issue: true, text: tradeBalance.message });
    }
  }
  const pendingRequirements = requirementRows.filter((r) => !r.done).length;

  function sortItems(items: InventoryItem[], s: string) {
    return [...items].sort((a, b) => {
      switch (s) {
        case "price-desc": return b.priceUsd - a.priceUsd;
        case "price-asc": return a.priceUsd - b.priceUsd;
        case "name-asc": return a.name.localeCompare(b.name);
        case "name-desc": return b.name.localeCompare(a.name);
        case "float-asc": return (a.floatValue ?? 1) - (b.floatValue ?? 1);
        case "float-desc": return (b.floatValue ?? 0) - (a.floatValue ?? 0);
        default: return 0;
      }
    });
  }

  function filterMy(items: InventoryItem[], q: string, s: string) {
    let r = items;
    if (q.trim()) { const ql = q.toLowerCase(); r = r.filter((i) => i.name.toLowerCase().includes(ql) || i.marketHashName.toLowerCase().includes(ql)); }
    return sortItems(r, s);
  }

  function filterOwner(items: InventoryItem[], q: string, s: string) {
    let r = items;
    if (q.trim()) { const ql = q.toLowerCase(); r = r.filter((i) => i.name.toLowerCase().includes(ql) || i.marketHashName.toLowerCase().includes(ql)); }
    if (category === "Weapon") {
      r = r.filter((i) => WEAPON_TYPES.some((wt) => i.type?.includes(wt)));
    } else if (category !== "All") {
      r = r.filter((i) => i.type?.includes(category));
    }
    if (wear !== "All") r = r.filter((i) => i.wear === wear);
    return sortItems(r, s);
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#0d0d0f] text-zinc-500">Загрузка...</div>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#0d0d0f] text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800/60 bg-[#111113] px-5 py-2.5">
        <a href="/" className="text-base font-bold tracking-tight text-amber-500">CHEZ<span className="text-zinc-300">TRADING</span></a>
        <nav className="flex items-center gap-5 text-sm text-zinc-500">
          <span className="text-amber-500/90">Обмен CS2</span>
        </nav>
        {!isLoggedIn ? (
          <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 transition-colors">
            Войти через Steam
          </a>
        ) : (
          <a href="/api/auth/logout" className="text-xs text-zinc-500 hover:text-zinc-300">Выйти</a>
        )}
      </header>

      {authError ? (
        <div
          className="border-b border-red-800/50 bg-red-950/50 px-5 py-2 text-sm text-red-300"
          role="alert"
        >
          {authError}
        </div>
      ) : null}
      {signedInNotice ? (
        <div className="border-b border-emerald-800/40 bg-emerald-950/30 px-5 py-2 text-sm text-emerald-400">
          Вы вошли через Steam.
        </div>
      ) : null}

      {selectionNotice ? (
        <div className="border-b border-amber-800/40 bg-amber-950/25 px-5 py-2 text-sm text-amber-200" role="status">
          {selectionNotice}
        </div>
      ) : null}

      {/* Messages */}
      {error && <div className="bg-red-900/30 border-b border-red-800/40 px-5 py-2 text-sm text-red-400">{error}</div>}
      {tradeSubmitError && (
        <div className="border-b border-red-800/40 bg-red-950/40 px-5 py-2 text-sm text-red-300" role="alert">
          {tradeSubmitError}
        </div>
      )}
      {tradeSuccess && <div className="bg-emerald-900/30 border-b border-emerald-800/40 px-5 py-2 text-sm text-emerald-400">{tradeSuccess}</div>}

      {/* 3-Column Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ─── LEFT: Your Inventory ─── */}
        <div className="flex w-[38%] min-w-0 flex-col border-r border-zinc-800/50">
          {/* Selected items strip */}
          <SelectedStrip
            label="Вы отдаёте"
            sublabel="Ваш инвентарь"
            items={selMyItems}
            total={myTotal}
            onRemove={(id) => toggle(setSelectedMy, id)}
            count={selectedMy.size}
            maxPerSide={MAX_TRADE_ITEMS_PER_SIDE}
          />

          {/* Content — each branch gets flex-1 + overflow-y-auto so it always fills the column */}
          {!isLoggedIn ? (
            <div className="flex flex-1 flex-col items-center justify-start gap-4 overflow-y-auto px-6 pb-6 pt-4 text-center">
              <div className="text-5xl opacity-20">🎮</div>
              <p className="max-w-xs text-sm text-zinc-500">Войдите через Steam, чтобы начать обменивать ваши CS2 скины на нашей платформе.</p>
              <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-semibold text-white hover:bg-amber-500">
                Войти через Steam
              </a>
            </div>
          ) : !hasTradeUrl || editingTradeUrl ? (
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col items-center gap-4 px-6 pb-6 pt-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-600/20 text-2xl">🔗</div>
                <h3 className="text-base font-bold text-zinc-100">
                  {hasTradeUrl ? "Обновите trade-ссылку" : "Вставьте вашу trade-ссылку"}
                </h3>
                <p className="max-w-xs text-center text-xs text-zinc-500">
                  Для загрузки вашего инвентаря нужна ваша trade-ссылка Steam. Можно вставить <strong className="text-zinc-400">только свою</strong> ссылку.
                </p>
                <div className="flex w-full max-w-sm flex-col gap-2">
                  <input
                    type="text"
                    placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
                    className="w-full rounded-lg border-2 border-amber-600/40 bg-zinc-800/80 px-3 py-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
                    value={tradeUrl}
                    onChange={(e) => setTradeUrl(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveTradeUrl} className="flex-1 rounded-lg bg-amber-600 py-2.5 text-xs font-bold text-white hover:bg-amber-500 transition-colors">
                      Сохранить и загрузить инвентарь
                    </button>
                    {hasTradeUrl && (
                      <button onClick={() => setEditingTradeUrl(false)} className="rounded-lg border border-zinc-700 px-4 py-2.5 text-xs text-zinc-400 hover:text-zinc-200">
                        Отмена
                      </button>
                    )}
                  </div>
                </div>
                <a
                  href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-amber-500/70 hover:text-amber-400 hover:underline"
                >
                  Где найти trade-ссылку? →
                </a>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <PanelHeader
                search={mySearch} onSearch={setMySearch}
                sort={mySort} onSort={setMySort}
                prefix="my"
                onRefresh={() => doRefresh("my", setMyRefreshing, setMyCooldown, loadMyInventory)}
                refreshing={myRefreshing} cooldown={myCooldown}
                tradeUrlAction={() => setEditingTradeUrl(true)}
              />
              <div className="flex-1 overflow-y-auto p-2">
                <ItemGrid items={filterMy(myItems, mySearch, mySort)} side="guest" selected={selectedMy} onToggle={(id) => toggle(setSelectedMy, id)} />
              </div>
            </div>
          )}
        </div>

        {/* ─── CENTER: Filters + Trade Summary ─── */}
        <div className="flex w-[24%] min-w-[260px] flex-col bg-[#111113] overflow-y-auto">
          <div className="flex flex-col gap-4 p-4">
            {/* Trade analysis */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-center">
                <div className="mb-0.5 text-[10px] text-zinc-500">Вы отдаёте</div>
                <p className="text-sm font-bold text-zinc-100">{fmtPrice(myTotal)}</p>
              </div>
              <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-center">
                <div className="mb-0.5 text-[10px] text-zinc-500">Вы получаете</div>
                <p className="text-sm font-bold text-zinc-100">{fmtPrice(ownerTotal)}</p>
              </div>
            </div>

            {tradeBalance && !tradeBalance.ok && tradeSelectionReady ? (
              <div
                className="flex gap-2 rounded-lg border border-amber-700/35 bg-zinc-900/90 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100/95"
                role="alert"
              >
                <span className="shrink-0 text-amber-500" aria-hidden>
                  ⚠
                </span>
                <p>{tradeBalance.message}</p>
              </div>
            ) : null}

            {/* Overpay + Submit */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10px] font-semibold ${overpayWordColor}`}>Переплата</span>
                    <span
                      className={`text-xs font-bold tabular-nums ${
                        overpayPct < 0
                          ? "text-orange-400"
                          : overpayPct > TRADE_MAX_OVERPAY_PERCENT
                            ? "text-red-400"
                            : "text-emerald-400/90"
                      }`}
                    >
                      {overpayPct > 0 ? "+" : ""}
                      {overpayPct.toFixed(1)}%
                      <span className="ml-1 text-[9px] font-normal text-zinc-500">(0–{TRADE_MAX_OVERPAY_PERCENT}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full transition-[width,background-color] duration-300"
                      style={{ width: `${overpayBarFillPct}%`, backgroundColor: overpayBarColor }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={submitTrade}
                  disabled={!canSubmit}
                  className={`shrink-0 rounded-lg px-4 py-2.5 text-xs font-bold transition-all ${
                    canSubmit
                      ? "bg-amber-600 text-white shadow-lg shadow-amber-600/20 hover:bg-amber-500 active:scale-[0.98]"
                      : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                  }`}
                >
                  {submitting ? "Отправка..." : "Отправить обмен"}
                </button>
              </div>
            </div>

            {/* Market info (reference-style) */}
            <div className="flex flex-col items-center gap-2.5" role="note">
              <div className="w-full rounded-lg border border-amber-900/25 bg-[#0c0c0e] px-3.5 py-3 text-center text-[11px] font-medium leading-snug text-amber-500">
                некоторые трейды могут быть отклонены из-за нестабильности рынка
              </div>
              <p className="w-full max-w-[260px] text-center text-[10px] leading-relaxed text-zinc-500">
                Цены могут отличаться из-за износа, паттерна или наклеек.
              </p>
            </div>

            {/* Divider */}
            <div className="border-t border-zinc-800/50" />

            {/* Item Type Categories */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="text-amber-500">◈</span> Тип предмета
              </h4>
              <div className="flex flex-col gap-1">
                {ITEM_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setCategory(cat.key)}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition-all ${
                      category === cat.key
                        ? "bg-amber-600/20 text-amber-400 font-semibold border border-amber-600/40"
                        : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 border border-transparent"
                    }`}
                  >
                    <span className="text-sm">{cat.icon}</span>
                    {cat.label}
                    {category === cat.key && <span className="ml-auto h-2 w-2 rounded-full bg-amber-500" />}
                  </button>
                ))}
              </div>
            </div>

            {/* Wear filter */}
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
                <span className="text-amber-500">◈</span> Износ
              </h4>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setWear("All")}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    wear === "All" ? "bg-amber-600/20 text-amber-400 border border-amber-600/40" : "text-zinc-500 hover:text-zinc-300 border border-zinc-800/60"
                  }`}
                >
                  Все
                </button>
                {WEAR_LABELS.map((w) => (
                  <button
                    key={w}
                    onClick={() => setWear(w)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      wear === w ? "bg-amber-600/20 text-amber-400 border border-amber-600/40" : "text-zinc-500 hover:text-zinc-300 border border-zinc-800/60"
                    }`}
                  >
                    {WEAR_SHORT[w]}
                  </button>
                ))}
              </div>
            </div>

            {/* Requirements */}
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3">
              {pendingRequirements > 0 ? (
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  {ruRequirementsHeading(pendingRequirements)}
                </p>
              ) : null}
              <div className="space-y-1.5">
                {requirementRows.map((row, idx) => (
                  <ReqLine key={`req-${idx}`} done={row.done} text={row.text} issue={row.issue} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Store Inventory ─── */}
        <div className="flex w-[38%] min-w-0 flex-col border-l border-zinc-800/50">
          <SelectedStrip
            label="Вы получаете"
            sublabel="Инвентарь платформы"
            items={selOwnerItems}
            total={ownerTotal}
            onRemove={(id) => toggle(setSelectedOwner, id)}
            count={selectedOwner.size}
            maxPerSide={MAX_TRADE_ITEMS_PER_SIDE}
            isRight
          />

          <PanelHeader
            search={ownerSearch} onSearch={setOwnerSearch}
            sort={ownerSort} onSort={setOwnerSort}
            prefix="owner"
            onRefresh={() => doRefresh("owner", setOwnerRefreshing, setOwnerCooldown, loadOwner)}
            refreshing={ownerRefreshing} cooldown={ownerCooldown}
          />
          <div className="flex-1 overflow-y-auto p-2">
                <ItemGrid
                  items={filterOwner(ownerItems, ownerSearch, ownerSort)}
                  side="owner"
                  selected={selectedOwner}
                  onToggle={(id) => toggle(setSelectedOwner, id)}
                  showAssetId={isAdmin}
                />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected Items Strip (top of each side panel)
// ---------------------------------------------------------------------------

function SelectedStrip({
  label, sublabel, items, total, onRemove, count, maxPerSide, isRight,
}: {
  label: string; sublabel: string; items: InventoryItem[]; total: number;
  onRemove: (id: string) => void; count: number; maxPerSide: number; isRight?: boolean;
}) {
  return (
    <div className="border-b border-zinc-800/50 bg-[#111113] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold ${count > 0 ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-500"}`}
              title={`Выбрано ${count} из ${maxPerSide}`}
            >
              {count}/{maxPerSide}
            </span>
            <span className="text-sm font-semibold text-zinc-200">{label}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-600">{sublabel}</p>
        </div>
        {total > 0 && <span className="shrink-0 text-sm font-bold text-amber-400">{fmtPrice(total)}</span>}
      </div>
      <div className="max-h-[min(240px,38vh)] overflow-y-auto overflow-x-hidden overscroll-y-contain pr-0.5 [scrollbar-gutter:stable]">
        {items.length === 0 ? (
          <p className="py-2 text-[11px] text-zinc-600">{isRight ? "Предметы не выбраны" : "Выберите предметы для обмена"}</p>
        ) : (
          <div className="flex flex-wrap gap-2 py-0.5">
            {items.map((item) => (
              <div key={item.assetId} className="group relative" title={item.name}>
                <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.iconUrl} alt="" className="h-full w-full object-contain" />
                  <button
                    type="button"
                    onClick={() => onRemove(item.assetId)}
                    className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[8px] font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirement line
// ---------------------------------------------------------------------------

function ReqLine({ done, text, issue }: { done: boolean; text: string; issue?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
          done
            ? "bg-emerald-600 text-white"
            : issue
              ? "border border-red-800/50 bg-red-950/40 text-red-400"
              : "bg-zinc-800 text-zinc-500"
        }`}
      >
        {done ? "✓" : issue ? "−" : "+"}
      </span>
      <span className={done ? "text-zinc-400 line-through" : issue ? "text-red-300/90" : "text-zinc-400"}>{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel Header (search + sort + refresh)
// ---------------------------------------------------------------------------

function PanelHeader({
  search, onSearch, sort, onSort, prefix,
  onRefresh, refreshing, cooldown, tradeUrlAction,
}: {
  search: string; onSearch: (v: string) => void;
  sort: string; onSort: (v: string) => void;
  prefix: string;
  onRefresh: () => void; refreshing: boolean; cooldown: number;
  tradeUrlAction?: () => void;
}) {
  return (
    <div className="border-b border-zinc-800/50 bg-[#0f0f11] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 text-xs">🔍</span>
          <input
            type="text"
            placeholder="Поиск предметов..."
            className="w-full rounded-lg border border-zinc-800/60 bg-zinc-900/60 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-amber-700/40 focus:outline-none"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <select
          aria-label={`${prefix}-sort`}
          className="rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400 focus:outline-none"
          value={sort}
          onChange={(e) => onSort(e.target.value)}
        >
          {SORT_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div
          className={`relative inline-flex rounded-lg ${cooldown > 0 && !refreshing ? "group/refcd cursor-not-allowed" : ""}`}
          title={cooldown > 0 && !refreshing ? `Следующее обновление через ${formatRefreshCooldownRu(cooldown)}` : undefined}
        >
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || cooldown > 0}
            className={`rounded-lg border p-1.5 text-xs transition-colors ${cooldown > 0 || refreshing ? "border-zinc-800 text-zinc-700 cursor-not-allowed" : "border-zinc-800/60 text-zinc-500 hover:text-zinc-300"}`}
            aria-label={cooldown > 0 ? `Следующее обновление через ${formatRefreshCooldownRu(cooldown)}` : "Обновить инвентарь"}
          >
            <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
          </button>
          {cooldown > 0 && !refreshing && (
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-[min(240px,calc(100vw-24px))] -translate-x-1/2 rounded-md border border-zinc-600/90 bg-zinc-950 px-2 py-1.5 text-center text-[10px] leading-snug text-zinc-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/refcd:opacity-100"
            >
              Следующее обновление через
              <br />
              <span className="font-semibold text-amber-400/90">{formatRefreshCooldownRu(cooldown)}</span>
            </span>
          )}
        </div>
        {tradeUrlAction && (
          <button onClick={tradeUrlAction} className="rounded-lg border border-zinc-800/60 p-1.5 text-[10px] text-zinc-600 hover:text-zinc-400" title="Изменить trade-ссылку">⚙</button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Grid
// ---------------------------------------------------------------------------

function ItemGrid({ items, side, selected, onToggle, showAssetId }: {
  items: InventoryItem[]; side: "owner" | "guest"; selected: Set<string>; onToggle: (id: string) => void;
  showAssetId?: boolean;
}) {
  if (items.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-zinc-600">Нет предметов</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((item) => (
        <ItemCard
          key={`${side}-${item.assetId}`}
          item={item}
          isSelected={selected.has(item.assetId)}
          onToggle={() => onToggle(item.assetId)}
          showAssetId={!!showAssetId && side === "owner"}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Card
// ---------------------------------------------------------------------------

function stickerLabel(s: { name: string }, i: number): string {
  const t = s.name?.trim();
  if (t) return t;
  return `Наклейка ${i + 1}`;
}

function RarityBar({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.style.setProperty("--rc", color); }, [color]);
  return <div ref={ref} className={`absolute inset-x-0 bottom-0 h-[2px] ${styles.rarityBar}`} />;
}

function InspectInGameButton({ href }: { href: string }) {
  return (
    <a
      href={href}
      title="Осмотреть в CS2"
      aria-label="Осмотреть в CS2"
      className="absolute bottom-1 right-1 z-[25] flex h-7 w-8 items-center justify-center rounded-full border border-red-950/60 bg-[#2a1518]/95 text-zinc-200 shadow-md backdrop-blur-[2px] transition-colors hover:border-amber-900/40 hover:bg-[#331a1d] hover:text-white"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.75" />
        <path d="M14.2 14.2L20 20" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        <path d="M10 7.25v5.5M7.25 10h5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </a>
  );
}

function ItemCard({ item, isSelected, onToggle, showAssetId }: {
  item: InventoryItem; isSelected: boolean; onToggle: () => void; showAssetId?: boolean;
}) {
  const [assetCopied, setAssetCopied] = useState(false);
  const hasTimedLock = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date();
  const isLocked = !item.tradable || hasTimedLock;
  const isUnavailable = item.belowThreshold && item.priceSource !== "manual";
  const disabled = isLocked || isUnavailable;

  const nameColor = item.rarityColor ?? "#e4e4e7";

  return (
    <div
      onClick={disabled ? undefined : onToggle}
      className={`group relative flex h-full min-h-[248px] flex-col overflow-visible rounded-xl border transition-all ${
        disabled
          ? "border-zinc-800/40 bg-zinc-900/40 opacity-50"
          : isSelected
            ? "border-amber-500/60 bg-zinc-800/80 ring-1 ring-amber-500/40 cursor-pointer"
            : "border-zinc-800/40 bg-zinc-900/60 hover:border-zinc-700/60 hover:bg-zinc-800/60 cursor-pointer"
      }`}
    >
      {isSelected && (
        <div className="absolute left-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-black">✓</div>
      )}

      {/* Top: Name + Wear */}
      <div className="shrink-0 flex flex-col items-center gap-1 px-2 pt-2">
        <p className="w-full truncate text-center text-[11px] font-semibold leading-tight" style={{ color: nameColor }} title={item.name}>
          {item.name}
        </p>
        {item.wear && (
          <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[9px] font-medium text-zinc-400">
            {item.wear}
          </span>
        )}
        {showAssetId ? (
          <div
            className="flex w-full max-w-full items-center gap-1 px-0.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span className="min-w-0 flex-1 truncate text-center font-mono text-[8px] leading-tight text-amber-600/90" title={item.assetId}>
              {item.assetId}
            </span>
            <button
              type="button"
              className="shrink-0 rounded border border-amber-800/40 bg-zinc-900/90 px-1 py-0.5 text-[8px] font-medium text-amber-500/90 hover:bg-zinc-800"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(item.assetId);
                  setAssetCopied(true);
                  window.setTimeout(() => setAssetCopied(false), 1200);
                } catch {
                  /* ignore */
                }
              }}
            >
              {assetCopied ? "✓" : "Копир."}
            </button>
          </div>
        ) : null}
      </div>

      {/* Image area — grows so footer aligns across the row */}
      <div className="relative flex min-h-[88px] flex-1 items-center justify-center px-2 py-2">
        {isUnavailable ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.iconUrl} alt="" className="h-[72px] w-[72px] object-contain blur-sm opacity-40" loading="lazy" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
              <span className="text-base text-zinc-500">ⓘ</span>
              <span className="text-[10px] font-semibold uppercase text-amber-600">UNAVAILABLE</span>
              <span className="text-[8px] text-zinc-500">(Unstable Price)</span>
            </div>
          </>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={item.iconUrl} alt={item.name} className="h-[72px] w-[72px] object-contain transition-transform group-hover:scale-105" loading="lazy" />
        )}

        {isLocked && (
          <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-orange-700/80 px-1 py-0.5 text-[8px] font-medium text-orange-100">
            🔒 {hasTimedLock ? fmtLock(item.tradeLockUntil!) : "Locked"}
          </div>
        )}

        {item.inspectLink ? <InspectInGameButton href={item.inspectLink} /> : null}

        {item.stickers.length > 0 && (
          <div className="group/stickers absolute bottom-1 left-1 z-20 max-w-[calc(100%-4px)]">
            <div
              className="flex flex-wrap gap-0.5"
              aria-label={item.stickers.map((s, i) => stickerLabel(s, i)).join(", ")}
            >
              {item.stickers.slice(0, 5).map((s, i) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={i}
                  src={s.iconUrl}
                  alt=""
                  className="h-[18px] w-[18px] rounded-sm border border-zinc-700/40 bg-zinc-900/80 object-contain drop-shadow"
                  loading="lazy"
                />
              ))}
              {item.stickers.length > 5 && (
                <span className="self-center text-[8px] text-zinc-500">+{item.stickers.length - 5}</span>
              )}
            </div>
            <div className="pointer-events-none invisible absolute bottom-full left-0 z-30 mb-1 w-max max-w-[min(240px,calc(100vw-32px))] rounded-md border border-zinc-600/90 bg-zinc-950 px-2 py-1.5 text-left text-[9px] leading-snug text-zinc-100 shadow-xl opacity-0 transition-opacity duration-150 group-hover/stickers:visible group-hover/stickers:opacity-100">
              <p className="mb-1 text-[8px] font-semibold uppercase tracking-wide text-zinc-500">Наклейки</p>
              <ul className="list-none space-y-1">
                {item.stickers.map((s, i) => (
                  <li key={`${item.assetId}-st-${i}`} className="break-words border-b border-zinc-800/80 pb-1 last:border-0 last:pb-0">
                    {stickerLabel(s, i)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Footer: fixed slots so float bars and prices line up in a grid row */}
      <div className="relative mt-auto flex w-full shrink-0 flex-col gap-0.5 px-2 pb-2 pt-0.5">
        <div className="flex min-h-[18px] items-center justify-center">
          {item.phaseLabel ? (
            <p className={`text-center text-[11px] font-bold leading-tight ${phaseTextColor(item.phaseLabel)}`}>
              {item.phaseLabel}
            </p>
          ) : null}
        </div>

        <div className="flex min-h-[34px] flex-col justify-end">
          {item.floatValue != null ? (
            <>
              <p className="text-[10px] leading-tight text-zinc-400">
                Float: <span className="font-medium text-zinc-200">{item.floatValue.toFixed(item.floatValue < 0.01 ? 6 : 4)}</span>
              </p>
              <div className="mt-0.5 h-1 w-full shrink-0 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full" style={{ width: `${Math.min(item.floatValue * 100, 100)}%`, backgroundColor: floatBarColor(item.floatValue) }} />
              </div>
            </>
          ) : (
            <div className="h-[34px] shrink-0" aria-hidden />
          )}
        </div>

        <div className="flex min-h-[22px] items-end justify-between">
          {item.priceSource === "unavailable" || isUnavailable ? (
            <span className="text-[10px] text-zinc-600">—</span>
          ) : (
            <span className="text-[13px] font-bold leading-none text-amber-400">{fmtPrice(item.priceUsd)}</span>
          )}
          {item.priceSource === "manual" && <span className="text-[8px] text-amber-700">manual</span>}
        </div>

        {item.rarityColor && <RarityBar color={item.rarityColor} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phaseTextColor(phase: string): string {
  switch (phase) {
    case "Ruby": return "text-red-500";
    case "Sapphire": return "text-blue-400";
    case "Emerald": return "text-emerald-400";
    case "Black Pearl": return "text-purple-400";
    case "Phase 1": return "text-pink-400";
    case "Phase 2": return "text-cyan-400";
    case "Phase 3": return "text-green-400";
    case "Phase 4": return "text-indigo-400";
    default: return "text-zinc-300";
  }
}

function floatBarColor(f: number): string {
  if (f < 0.07) return "#22c55e";
  if (f < 0.15) return "#84cc16";
  if (f < 0.38) return "#eab308";
  if (f < 0.45) return "#f97316";
  return "#ef4444";
}

function fmtLock(iso: string): string {
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return "";
  const days = Math.floor(d / 86_400_000);
  const hrs = Math.floor((d % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}д`;
  return `${hrs}ч`;
}
