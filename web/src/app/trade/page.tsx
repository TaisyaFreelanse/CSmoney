"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

// ---------------------------------------------------------------------------
// Main Component
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
  const [submitting, setSubmitting] = useState(false);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);

  const [ownerRefreshing, setOwnerRefreshing] = useState(false);
  const [myRefreshing, setMyRefreshing] = useState(false);
  const [ownerCooldown, setOwnerCooldown] = useState(0);
  const [myCooldown, setMyCooldown] = useState(0);

  const [selectedMy, setSelectedMy] = useState<Set<string>>(new Set());
  const [selectedOwner, setSelectedOwner] = useState<Set<string>>(new Set());

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
    if (res.ok && data?.items) setOwnerItems(data.items);
    else setError(data?.message ?? `Магазин: ${data?.error ?? "ошибка"}`);
  }, []);

  const loadMyInventory = useCallback(async () => {
    const res = await fetch("/api/inventory/me");
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) setMyItems(data.items);
    else if (data?.error !== "trade_url_required" && data?.error !== "unauthorized")
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
      if (myRes.ok) { const d = await myRes.json(); setMyItems(d.items ?? []); }
    } else {
      const err = await res.json().catch(() => null);
      setError(err?.message ?? "Ошибка сохранения trade-ссылки");
    }
  }, [tradeUrl]);

  // ------ cooldown ------
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
      if (res.status === 429) setC(Math.ceil((data?.retryAfterMs ?? 120000) / 1000));
      else if (res.ok) { setC(120); await reload(); }
      else setError(data?.message ?? "Ошибка обновления");
    } finally { setR(false); }
  }, []);

  // ------ selection ------
  const toggle = useCallback((set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    set((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  // ------ submit trade ------
  const submitTrade = useCallback(async () => {
    setError(null); setTradeSuccess(null); setSubmitting(true);
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestItems: Array.from(selectedMy), ownerItems: Array.from(selectedOwner) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.message ?? data?.error ?? "Ошибка"); return; }
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
  const overpay = ownerTotal > 0 ? ((myTotal - ownerTotal) / ownerTotal) * 100 : 0;
  const canSubmit = selectedMy.size > 0 && selectedOwner.size > 0 && !submitting;

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
        <nav className="flex items-center gap-5 text-sm text-zinc-400">
          <a href="/" className="hover:text-zinc-200">Главная</a>
          <a href="/trade" className="text-amber-500">Обмен</a>
        </nav>
        {!isLoggedIn ? (
          <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 transition-colors">
            Войти через Steam
          </a>
        ) : (
          <a href="/api/auth/logout" className="text-xs text-zinc-500 hover:text-zinc-300">Выйти</a>
        )}
      </header>

      {/* Messages */}
      {error && <div className="bg-red-900/30 border-b border-red-800/40 px-5 py-2 text-sm text-red-400">{error}</div>}
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
          />

          {/* Content */}
          {!isLoggedIn ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
              <div className="text-5xl opacity-20">🎮</div>
              <p className="text-sm text-zinc-500">Войдите через Steam, чтобы начать обменивать ваши CS2 скины на нашей платформе.</p>
              <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-semibold text-white hover:bg-amber-500">
                Войти через Steam
              </a>
            </div>
          ) : !hasTradeUrl || editingTradeUrl ? (
            <div className="flex flex-col items-center gap-4 p-6 pt-10">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-600/20 text-3xl">🔗</div>
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
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

            {/* Overpay + Submit row */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-3 py-2">
                <span className="text-[10px] text-zinc-500">Переплата</span>
                <span className={`text-xs font-bold ${overpay > 0 ? "text-red-400" : overpay < 0 ? "text-emerald-400" : "text-zinc-400"}`}>
                  {overpay > 0 ? "+" : ""}{overpay.toFixed(1)}%
                </span>
              </div>
              <button
                onClick={submitTrade}
                disabled={!canSubmit}
                className={`flex-1 rounded-lg py-2.5 text-xs font-bold transition-all ${
                  canSubmit
                    ? "bg-amber-600 text-white shadow-lg shadow-amber-600/20 hover:bg-amber-500 active:scale-[0.98]"
                    : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                }`}
              >
                {submitting ? "Отправка..." : "Отправить обмен"}
              </button>
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
              <div className="space-y-1.5">
                <ReqLine done={selectedMy.size > 0} text="Добавьте ваши предметы" />
                <ReqLine done={selectedOwner.size > 0} text="Выберите предметы магазина" />
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
            isRight
          />

          <PanelHeader
            search={ownerSearch} onSearch={setOwnerSearch}
            sort={ownerSort} onSort={setOwnerSort}
            prefix="owner"
            onRefresh={() => doRefresh("owner", setOwnerRefreshing, setOwnerCooldown, loadOwner)}
            refreshing={ownerRefreshing} cooldown={ownerCooldown}
            totalValue={ownerItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0)}
          />
          <div className="flex-1 overflow-y-auto p-2">
            <ItemGrid items={filterOwner(ownerItems, ownerSearch, ownerSort)} side="owner" selected={selectedOwner} onToggle={(id) => toggle(setSelectedOwner, id)} />
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
  label, sublabel, items, total, onRemove, count, isRight,
}: {
  label: string; sublabel: string; items: InventoryItem[]; total: number;
  onRemove: (id: string) => void; count: number; isRight?: boolean;
}) {
  return (
    <div className="border-b border-zinc-800/50 bg-[#111113] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${count > 0 ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-500"}`}>
              {count}
            </span>
            <span className="text-sm font-semibold text-zinc-200">{label}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-600">{sublabel}</p>
        </div>
        {total > 0 && <span className="text-sm font-bold text-amber-400">{fmtPrice(total)}</span>}
      </div>
      <div className="flex min-h-[52px] items-center gap-1.5 overflow-x-auto">
        {items.length === 0 ? (
          <p className="text-[11px] text-zinc-600">{isRight ? "Предметы не выбраны" : "Выберите предметы для обмена"}</p>
        ) : (
          items.map((item) => (
            <div key={item.assetId} className="group relative flex-shrink-0" title={item.name}>
              <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-0.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.iconUrl} alt="" className="h-full w-full object-contain" />
                <button onClick={() => onRemove(item.assetId)} className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-600 text-[8px] font-bold text-white opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirement line
// ---------------------------------------------------------------------------

function ReqLine({ done, text }: { done: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${done ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-500"}`}>
        {done ? "✓" : "+"}
      </span>
      <span className={done ? "text-zinc-400 line-through" : "text-zinc-400"}>{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel Header (search + sort + refresh)
// ---------------------------------------------------------------------------

function PanelHeader({
  search, onSearch, sort, onSort, prefix,
  onRefresh, refreshing, cooldown, tradeUrlAction, totalValue,
}: {
  search: string; onSearch: (v: string) => void;
  sort: string; onSort: (v: string) => void;
  prefix: string;
  onRefresh: () => void; refreshing: boolean; cooldown: number;
  tradeUrlAction?: () => void;
  totalValue?: number;
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
        {totalValue !== undefined && totalValue > 0 && (
          <span className="whitespace-nowrap text-xs font-semibold text-amber-400">{fmtPrice(totalValue)}</span>
        )}
        <select
          aria-label={`${prefix}-sort`}
          className="rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400 focus:outline-none"
          value={sort}
          onChange={(e) => onSort(e.target.value)}
        >
          {SORT_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button
          onClick={onRefresh}
          disabled={refreshing || cooldown > 0}
          className={`rounded-lg border p-1.5 text-xs transition-colors ${cooldown > 0 || refreshing ? "border-zinc-800 text-zinc-700 cursor-not-allowed" : "border-zinc-800/60 text-zinc-500 hover:text-zinc-300"}`}
          title={cooldown > 0 ? `${cooldown}с` : "Обновить"}
        >
          <span className={refreshing ? "animate-spin inline-block" : ""}>↻</span>
        </button>
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

function ItemGrid({ items, side, selected, onToggle }: {
  items: InventoryItem[]; side: "owner" | "guest"; selected: Set<string>; onToggle: (id: string) => void;
}) {
  if (items.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-zinc-600">Нет предметов</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((item) => (
        <ItemCard key={`${side}-${item.assetId}`} item={item} isSelected={selected.has(item.assetId)} onToggle={() => onToggle(item.assetId)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Card
// ---------------------------------------------------------------------------

function RarityBar({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.style.setProperty("--rc", color); }, [color]);
  return <div ref={ref} className={`absolute inset-x-0 bottom-0 h-[2px] ${styles.rarityBar}`} />;
}

function ItemCard({ item, isSelected, onToggle }: { item: InventoryItem; isSelected: boolean; onToggle: () => void }) {
  const hasTimedLock = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date();
  const isLocked = !item.tradable || hasTimedLock;
  const isUnavailable = item.belowThreshold && item.priceSource !== "manual";
  const disabled = isLocked || isUnavailable;
  const wearShort = item.wear ? WEAR_SHORT[item.wear] ?? item.wear : null;

  return (
    <div
      onClick={disabled ? undefined : onToggle}
      className={`group relative flex flex-col overflow-hidden rounded-xl transition-all ${
        disabled
          ? "bg-zinc-900/40 opacity-50"
          : isSelected
            ? "bg-zinc-800/80 ring-2 ring-amber-500/60 cursor-pointer"
            : "bg-zinc-900/60 hover:bg-zinc-800/60 cursor-pointer"
      }`}
    >
      {/* Selection badge */}
      {isSelected && (
        <div className="absolute left-1.5 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-black">✓</div>
      )}

      {/* Image area */}
      <div className="relative flex items-center justify-center px-2 pb-0 pt-3">
        {isUnavailable ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.iconUrl} alt="" className="h-[72px] w-[72px] object-contain blur-sm opacity-40" loading="lazy" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="rounded bg-zinc-900/90 px-2 py-1 text-center text-[9px] font-semibold uppercase leading-tight text-zinc-500">UNAVAILABLE<br />Price too low</span>
            </div>
          </>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={item.iconUrl} alt={item.name} className="h-[72px] w-[72px] object-contain transition-transform group-hover:scale-105" loading="lazy" />
        )}

        {/* Trade lock */}
        {isLocked && (
          <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-orange-700/80 px-1 py-0.5 text-[8px] font-medium text-orange-100">
            🔒 {hasTimedLock ? fmtLock(item.tradeLockUntil!) : "Locked"}
          </div>
        )}

        {/* Stickers */}
        {item.stickers.length > 0 && (
          <div className="absolute bottom-0 left-1 flex gap-0.5" title={item.stickers.map((s) => s.name).join(", ")}>
            {item.stickers.slice(0, 5).map((s, i) => (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img key={i} src={s.iconUrl} alt={s.name} className="h-[18px] w-[18px] rounded-sm drop-shadow" loading="lazy" />
            ))}
            {item.stickers.length > 5 && <span className="text-[8px] text-zinc-500">+{item.stickers.length - 5}</span>}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="relative flex flex-col gap-0.5 px-2 pb-2 pt-1.5">
        {/* Phase label (prominent, like sargee) */}
        {item.phaseLabel && (
          <span className={`mb-0.5 self-start rounded px-1.5 py-0.5 text-[9px] font-bold ${phaseStyle(item.phaseLabel)}`}>
            {item.phaseLabel}
          </span>
        )}

        {/* Name */}
        <p className="truncate text-[11px] font-medium leading-tight text-zinc-200" title={item.name}>{item.name}</p>

        {/* Wear badge */}
        {wearShort && (
          <span className="self-start rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-400">
            {wearShort}
          </span>
        )}

        {/* Float */}
        {item.floatValue != null && (
          <div className="mt-0.5">
            <p className="text-[10px] font-medium text-emerald-400">Float: {item.floatValue.toFixed(item.floatValue < 0.01 ? 6 : 4)}</p>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <svg
                className="block h-full w-full"
                viewBox="0 0 100 1"
                preserveAspectRatio="none"
                aria-hidden
              >
                <rect
                  x={0}
                  y={0}
                  width={Math.min(item.floatValue * 100, 100)}
                  height={1}
                  fill={floatBarColor(item.floatValue)}
                  rx={0.5}
                />
              </svg>
            </div>
          </div>
        )}

        {/* Price */}
        <div className="mt-auto flex items-center justify-between pt-1">
          {item.priceSource === "unavailable" || isUnavailable ? (
            <span className="text-[10px] text-zinc-600">—</span>
          ) : (
            <span className="text-xs font-bold text-amber-400">{fmtPrice(item.priceUsd)}</span>
          )}
          {item.priceSource === "manual" && <span className="text-[8px] text-amber-700">manual</span>}
        </div>

        {/* Rarity bar */}
        {item.rarityColor && <RarityBar color={item.rarityColor} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phaseStyle(phase: string): string {
  switch (phase) {
    case "Ruby": return "bg-red-900/60 text-red-400";
    case "Sapphire": return "bg-blue-900/60 text-blue-400";
    case "Emerald": return "bg-emerald-900/60 text-emerald-400";
    case "Black Pearl": return "bg-purple-900/60 text-purple-400";
    case "Phase 1": return "bg-pink-900/40 text-pink-400";
    case "Phase 2": return "bg-cyan-900/40 text-cyan-400";
    case "Phase 3": return "bg-green-900/40 text-green-400";
    case "Phase 4": return "bg-indigo-900/40 text-indigo-400";
    default: return "bg-zinc-800 text-zinc-300";
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
