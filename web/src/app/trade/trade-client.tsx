"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { OWNER_REFRESH_COOLDOWN_MS, USER_REFRESH_COOLDOWN_MS } from "@/lib/inventory-refresh-limits";
import {
  checkTradeBalance,
  MAX_TRADE_ITEMS_PER_SIDE,
  TRADE_MAX_OVERPAY_PERCENT,
  tradeOverpayPercent,
} from "@/lib/trade-balance";
import {
  t,
  requirementsHeading,
  formatRefreshCooldown,
  fmtLockI18n,
  formatTradeLockDateDisplay,
  lockedManualCardSubtitle,
  lockedManualItemNativeTitle,
  lockedManualItemToastMessage,
  type LangCode,
} from "@/lib/i18n";
import { DEFAULT_FX_RATES, type SupportedFxCode } from "@/lib/fx-rates";
import { OWNER_INVENTORY_PAGE_MAX } from "@/lib/owner-inventory-api-constants";

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
  /** From admin trade-lock JSON (context 16 export); not merged with Steam by asset id. */
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_KEYS = [
  { key: "All", i18n: "catAll", icon: "◈" },
  { key: "Weapon", i18n: "catWeapon", icon: "🎯" },
  { key: "Knife", i18n: "catKnife", icon: "🔪" },
  { key: "Gloves", i18n: "catGloves", icon: "🧤" },
  { key: "Sticker", i18n: "catSticker", icon: "🏷" },
  { key: "Graffiti", i18n: "catGraffiti", icon: "🎨" },
  { key: "Agent", i18n: "catAgent", icon: "🕵" },
  { key: "Music Kit", i18n: "catMusicKit", icon: "🎵" },
  { key: "Patch", i18n: "catPatch", icon: "🛡" },
  { key: "Charm", i18n: "catCharm", icon: "🔑" },
  { key: "Container", i18n: "catContainer", icon: "📦" },
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

const INV_FILTERS_STORAGE_KEY = "chez_inventory_filters_v1";

function isStatTrakItem(i: Pick<InventoryItem, "name" | "marketHashName">): boolean {
  return /stattrak/i.test(i.name) || /stattrak/i.test(i.marketHashName);
}

function isSouvenirItem(i: Pick<InventoryItem, "name" | "marketHashName">): boolean {
  return /\bsouvenir\b/i.test(i.name) || /\bsouvenir\b/i.test(i.marketHashName);
}

function isItemTradeLocked(i: InventoryItem): boolean {
  if (i.locked === true) return true;
  const hasTimed = !!i.tradeLockUntil && new Date(i.tradeLockUntil) > new Date();
  return !i.tradable || hasTimed;
}

function parseUsdToCentsBound(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  if (!t) return null;
  const v = parseFloat(t);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

type InvFiltersPersisted = {
  showStatTrak?: boolean;
  showSouvenir?: boolean;
  showTradeLocked?: boolean;
  priceMinStr?: string;
  priceMaxStr?: string;
  floatMin?: number;
  floatMax?: number;
};

function readInvFiltersPersisted(): InvFiltersPersisted | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(INV_FILTERS_STORAGE_KEY) || "null") as InvFiltersPersisted | null;
  } catch {
    return null;
  }
}

const SORT_KEYS = [
  { key: "price-desc", i18n: "sortPriceDesc" },
  { key: "price-asc", i18n: "sortPriceAsc" },
  { key: "name-asc", i18n: "sortNameAsc" },
  { key: "name-desc", i18n: "sortNameDesc" },
  { key: "float-asc", i18n: "sortFloatAsc" },
  { key: "float-desc", i18n: "sortFloatDesc" },
] as const;

const ITEMS_PER_PAGE = 30;
const SKELETON_CARD_COUNT = 15;

const CURRENCIES = [
  { code: "USD" as const, symbol: "$", flag: "🇺🇸", rate: DEFAULT_FX_RATES.USD },
  { code: "EUR" as const, symbol: "€", flag: "🇪🇺", rate: DEFAULT_FX_RATES.EUR },
  { code: "RUB" as const, symbol: "₽", flag: "🇷🇺", rate: DEFAULT_FX_RATES.RUB },
  { code: "CNY" as const, symbol: "¥", flag: "🇨🇳", rate: DEFAULT_FX_RATES.CNY },
  { code: "UAH" as const, symbol: "₴", flag: "🇺🇦", rate: DEFAULT_FX_RATES.UAH },
] as const;
type CurrencyCode = SupportedFxCode;

const LANGUAGES = [
  { code: "ru" as LangCode, label: "Русский", flag: "🇷🇺" },
  { code: "en" as LangCode, label: "English", flag: "🇬🇧" },
  { code: "zh" as LangCode, label: "中文", flag: "🇨🇳" },
] as const;

function fmtPrice(
  cents: number,
  currencyCode: CurrencyCode = "USD",
  ratesByCode: Record<CurrencyCode, number> = DEFAULT_FX_RATES,
) {
  const cur = CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0];
  const rate = ratesByCode[currencyCode] ?? cur.rate;
  const val = (cents / 100) * rate;
  return `${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur.symbol}`;
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
  const [ownerInventoryLoading, setOwnerInventoryLoading] = useState(true);
  const [myInventoryLoading, setMyInventoryLoading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradeSubmitError, setTradeSubmitError] = useState<string | null>(null);
  const [tradeUrl, setTradeUrl] = useState("");
  const [hasTradeUrl, setHasTradeUrl] = useState(false);
  const [editingTradeUrl, setEditingTradeUrl] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const [tradeSubmitModalOpen, setTradeSubmitModalOpen] = useState(false);
  const [tradeSubmitModalPhase, setTradeSubmitModalPhase] = useState<"pick" | "site_done" | "manual_checklist">("pick");
  const [manualChecklistGuest, setManualChecklistGuest] = useState<InventoryItem[]>([]);
  const [manualChecklistOwner, setManualChecklistOwner] = useState<InventoryItem[]>([]);
  const [tradeModalBusy, setTradeModalBusy] = useState(false);
  const [tradeModalError, setTradeModalError] = useState<string | null>(null);
  const [tradeModalCreatedId, setTradeModalCreatedId] = useState<string | null>(null);
  const tradeModalSnapshotRef = useRef<{ guest: string[]; owner: string[] } | null>(null);

  const [ownerRefreshing, setOwnerRefreshing] = useState(false);
  const [myRefreshing, setMyRefreshing] = useState(false);
  const [ownerCooldown, setOwnerCooldown] = useState(0);
  const [myCooldown, setMyCooldown] = useState(0);

  const [selectedMy, setSelectedMy] = useState<Set<string>>(new Set());
  const [selectedOwner, setSelectedOwner] = useState<Set<string>>(new Set());
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [lockedTapNotice, setLockedTapNotice] = useState<string | null>(null);
  const lockedTapNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-panel search/sort
  const [mySearch, setMySearch] = useState("");
  const [mySort, setMySort] = useState("price-desc");
  const [ownerSearch, setOwnerSearch] = useState("");
  const [ownerSort, setOwnerSort] = useState("price-desc");

  // Center filters (apply to both panels)
  const [category, setCategory] = useState("All");
  const [wear, setWear] = useState("All");

  const [invShowStatTrak, setInvShowStatTrak] = useState(true);
  const [invShowSouvenir, setInvShowSouvenir] = useState(true);
  const [invShowTradeLocked, setInvShowTradeLocked] = useState(true);
  const [invPriceMinStr, setInvPriceMinStr] = useState("");
  const [invPriceMaxStr, setInvPriceMaxStr] = useState("");
  const [invFloatMin, setInvFloatMin] = useState(0);
  const [invFloatMax, setInvFloatMax] = useState(1);
  const [invFiltersHydrated, setInvFiltersHydrated] = useState(false);

  useEffect(() => {
    const p = readInvFiltersPersisted();
    if (p) {
      if (typeof p.showStatTrak === "boolean") setInvShowStatTrak(p.showStatTrak);
      if (typeof p.showSouvenir === "boolean") setInvShowSouvenir(p.showSouvenir);
      if (typeof p.showTradeLocked === "boolean") setInvShowTradeLocked(p.showTradeLocked);
      if (typeof p.priceMinStr === "string") setInvPriceMinStr(p.priceMinStr);
      if (typeof p.priceMaxStr === "string") setInvPriceMaxStr(p.priceMaxStr);
      let fMin = 0;
      let fMax = 1;
      if (typeof p.floatMin === "number" && Number.isFinite(p.floatMin)) fMin = Math.max(0, Math.min(1, p.floatMin));
      if (typeof p.floatMax === "number" && Number.isFinite(p.floatMax)) fMax = Math.max(0, Math.min(1, p.floatMax));
      if (fMin > fMax) [fMin, fMax] = [fMax, fMin];
      setInvFloatMin(fMin);
      setInvFloatMax(fMax);
    }
    setInvFiltersHydrated(true);
  }, []);

  useEffect(() => {
    if (!invFiltersHydrated) return;
    const payload: InvFiltersPersisted = {
      showStatTrak: invShowStatTrak,
      showSouvenir: invShowSouvenir,
      showTradeLocked: invShowTradeLocked,
      priceMinStr: invPriceMinStr,
      priceMaxStr: invPriceMaxStr,
      floatMin: invFloatMin,
      floatMax: invFloatMax,
    };
    try {
      localStorage.setItem(INV_FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota */
    }
  }, [
    invFiltersHydrated,
    invShowStatTrak,
    invShowSouvenir,
    invShowTradeLocked,
    invPriceMinStr,
    invPriceMaxStr,
    invFloatMin,
    invFloatMax,
  ]);

  // Language & Currency
  const [currency, setCurrency] = useState<CurrencyCode>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("chez_currency") as CurrencyCode) || "USD";
    }
    return "USD";
  });
  const [fxRatesByCode, setFxRatesByCode] = useState<Record<CurrencyCode, number>>(() => ({ ...DEFAULT_FX_RATES }));
  const [lang, setLang] = useState<LangCode>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("chez_lang") as LangCode) || "ru";
    }
    return "ru";
  });

  const overpayBarFillRef = useRef<HTMLDivElement>(null);

  useEffect(() => { localStorage.setItem("chez_currency", currency); }, [currency]);
  useEffect(() => { localStorage.setItem("chez_lang", lang); }, [lang]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fx-rates", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { rates?: Partial<Record<CurrencyCode, number>> };
        if (!data.rates || cancelled) return;
        setFxRatesByCode((prev) => {
          const next = { ...prev };
          for (const c of CURRENCIES) {
            const v = data.rates![c.code];
            if (typeof v === "number" && Number.isFinite(v) && v > 0) next[c.code] = v;
          }
          return next;
        });
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fmt = useCallback(
    (cents: number) => fmtPrice(cents, currency, fxRatesByCode),
    [currency, fxRatesByCode],
  );

  const formatTradeApiError = useCallback(
    (data: Record<string, unknown> | null): string => {
      if (!data) return t("errorGenericShort", lang);
      if (data.error === "overpay_too_low" && typeof data.shortfallCents === "number") {
        return `${t("addItemsOrRemove", lang)} ${fmt(data.shortfallCents)} (${t("overpayNotBelow", lang)})`;
      }
      if (data.error === "overpay_too_high" && typeof data.excessCents === "number") {
        return `${t("reduceOverpayBy", lang)} ${fmt(data.excessCents)} (${t("maxPercent", lang)} ${TRADE_MAX_OVERPAY_PERCENT}%)`;
      }
      if (data.error === "no_pricing") return t("tradeNoPricing", lang);
      const msg = data.message;
      return typeof msg === "string" ? msg : typeof data.error === "string" ? data.error : t("errorGenericShort", lang);
    },
    [fmt, lang],
  );

  const executeTradeSubmit = useCallback(async () => {
    const snap = tradeModalSnapshotRef.current;
    if (!snap) return { ok: false as const, error: t("errorGenericShort", lang) };
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestItems: snap.guest, ownerItems: snap.owner }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return { ok: false as const, error: formatTradeApiError(data) };
    }
    return {
      ok: true as const,
      tradeId: String(data?.tradeId ?? ""),
      ownerTradeUrl: typeof data?.ownerTradeUrl === "string" ? data.ownerTradeUrl : null,
    };
  }, [formatTradeApiError, lang]);

  const closeTradeSubmitModal = useCallback(() => {
    setTradeSubmitModalOpen(false);
    setTradeSubmitModalPhase("pick");
    setTradeModalError(null);
    setTradeModalCreatedId(null);
    setTradeModalBusy(false);
    setManualChecklistGuest([]);
    setManualChecklistOwner([]);
    tradeModalSnapshotRef.current = null;
  }, []);

  const openTradeSubmitModal = useCallback(() => {
    setError(null);
    setTradeSubmitError(null);
    tradeModalSnapshotRef.current = {
      guest: Array.from(selectedMy),
      owner: Array.from(selectedOwner),
    };
    setTradeSubmitModalPhase("pick");
    setTradeModalError(null);
    setTradeModalCreatedId(null);
    setTradeSubmitModalOpen(true);
  }, [selectedMy, selectedOwner]);

  const handleTradeModalManual = useCallback(async () => {
    setTradeModalBusy(true);
    setTradeModalError(null);
    const snap = tradeModalSnapshotRef.current;
    const r = await executeTradeSubmit();
    setTradeModalBusy(false);
    if (!r.ok) {
      setTradeModalError(r.error);
      return;
    }
    const guestResolved = (snap?.guest ?? [])
      .map((id) => myItems.find((i) => i.assetId === id))
      .filter((x): x is InventoryItem => !!x);
    const ownerResolved = (snap?.owner ?? [])
      .map((id) => ownerItems.find((i) => i.assetId === id))
      .filter((x): x is InventoryItem => !!x);
    setManualChecklistGuest(guestResolved);
    setManualChecklistOwner(ownerResolved);
    setTradeModalCreatedId(r.tradeId && r.tradeId.length > 0 ? r.tradeId : null);
    setSelectedMy(new Set());
    setSelectedOwner(new Set());
    if (r.ownerTradeUrl) {
      window.open(r.ownerTradeUrl, "_blank", "noopener,noreferrer");
    } else {
      setTradeSubmitError(t("tradeSubmitNoStoreUrl", lang));
    }
    setTradeSubmitModalPhase("manual_checklist");
  }, [executeTradeSubmit, lang, myItems, ownerItems]);

  const handleTradeModalSite = useCallback(async () => {
    setTradeModalBusy(true);
    setTradeModalError(null);
    const r = await executeTradeSubmit();
    setTradeModalBusy(false);
    if (!r.ok) {
      setTradeModalError(r.error);
      return;
    }
    setSelectedMy(new Set());
    setSelectedOwner(new Set());
    setTradeModalCreatedId(r.tradeId);
    setTradeSubmitModalPhase("site_done");
  }, [executeTradeSubmit]);

  useEffect(() => {
    if (!tradeSubmitModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (tradeSubmitModalPhase === "manual_checklist") return;
      closeTradeSubmitModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tradeSubmitModalOpen, tradeSubmitModalPhase, closeTradeSubmitModal]);

  useEffect(() => {
    if (!tradeSubmitModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [tradeSubmitModalOpen]);

  // ------ loaders ------
  const loadOwner = useCallback(
    async (signal?: AbortSignal) => {
      /** One HTTP round-trip for typical shops; extra iterations only if total > OWNER_INVENTORY_PAGE_MAX. */
      const pageLimit = OWNER_INVENTORY_PAGE_MAX;
      const all: InventoryItem[] = [];
      let offset = 0;
      let lastCooldownMs: number | undefined;

      for (;;) {
        if (signal?.aborted) return;
        const qs = new URLSearchParams({
          limit: String(pageLimit),
          offset: String(offset),
        });
        let res: Response;
        try {
          res = await fetch(`/api/inventory/owner?${qs.toString()}`, {
            credentials: "include",
            signal,
          });
        } catch {
          if (signal?.aborted) return;
          setOwnerItems([]);
          setError(`${t("errorShop", lang)}: ${t("errorGeneric", lang)}`);
          return;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data?.items)) {
          if (!signal?.aborted) {
            setOwnerItems([]);
            setError(data?.message ?? `${t("errorShop", lang)}: ${data?.error ?? t("errorGeneric", lang)}`);
          }
          return;
        }
        const batch = data.items as InventoryItem[];
        const seen = new Set(all.map((i) => i.assetId));
        for (const it of batch) {
          if (!seen.has(it.assetId)) {
            seen.add(it.assetId);
            all.push(it);
          }
        }
        if (typeof data.refreshCooldownRemainingMs === "number") {
          lastCooldownMs = data.refreshCooldownRemainingMs;
        }
        const hasMore =
          typeof data.hasMore === "boolean"
            ? data.hasMore
            : typeof data.total === "number"
              ? offset + batch.length < data.total
              : batch.length >= pageLimit;
        if (!hasMore || batch.length === 0) break;
        offset += batch.length;
        if (offset > 100_000) break;
      }

      if (signal?.aborted) return;
      setOwnerItems(all);
      setError(null);
      if (lastCooldownMs != null && lastCooldownMs > 0) {
        setOwnerCooldown(Math.ceil(lastCooldownMs / 1000));
      }
    },
    [lang],
  );

  const loadMyInventory = useCallback(async () => {
    const res = await fetch("/api/inventory/me", { credentials: "include" });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.items) {
      setMyItems(data.items);
      if (typeof data.refreshCooldownRemainingMs === "number" && data.refreshCooldownRemainingMs > 0) {
        setMyCooldown(Math.ceil(data.refreshCooldownRemainingMs / 1000));
      }
    } else if (data?.error !== "trade_url_required" && data?.error !== "unauthorized")
      setError(`${t("errorInventory", lang)}: ${data?.error ?? t("errorGeneric", lang)}`);
  }, [lang]);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;

    (async () => {
      setOwnerInventoryLoading(true);
      try {
        await loadOwner(ac.signal);
      } finally {
        if (!ac.signal.aborted) setOwnerInventoryLoading(false);
      }
    })();

    (async () => {
      const meRes = await fetch("/api/auth/me", { credentials: "include" });
      if (cancelled) return;
      if (!meRes.ok) {
        setAuthReady(true);
        return;
      }
      const meData = (await meRes.json().catch(() => null)) as { user?: unknown } | null;
      if (cancelled) return;
      if (meData?.user) {
        setIsLoggedIn(true);
        const tradeRes = await fetch("/api/profile/trade-url", { credentials: "include" });
        let hasUrl = false;
        if (tradeRes.ok) {
          const td = (await tradeRes.json().catch(() => null)) as { hasTradeUrl?: boolean; tradeUrl?: string | null } | null;
          if (td) {
            hasUrl = !!td.hasTradeUrl;
            setHasTradeUrl(hasUrl);
            setTradeUrl(td.tradeUrl ?? "");
          }
        }
        if (hasUrl) {
          setMyInventoryLoading(true);
          try {
            await loadMyInventory();
          } finally {
            if (!cancelled) setMyInventoryLoading(false);
          }
        }
      }
      if (!cancelled) setAuthReady(true);
    })();

    return () => {
      ac.abort();
      cancelled = true;
    };
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
      setMyInventoryLoading(true);
      try {
        const myRes = await fetch("/api/inventory/me", { credentials: "include" });
        if (myRes.ok) {
          const d = await myRes.json();
          setMyItems(d.items ?? []);
          if (typeof d.refreshCooldownRemainingMs === "number" && d.refreshCooldownRemainingMs > 0) {
            setMyCooldown(Math.ceil(d.refreshCooldownRemainingMs / 1000));
          }
        }
      } finally {
        setMyInventoryLoading(false);
      }
    } else {
      const err = await res.json().catch(() => null);
      setError(err?.message ?? t("errorSaveTradeUrl", lang));
    }
  }, [tradeUrl]);

  // ------ cooldown ------
  useEffect(() => {
    setTradeSubmitError(null);
  }, [selectedMy, selectedOwner]);

  const showLockedTapNotice = useCallback(
    (item: InventoryItem) => {
      setLockedTapNotice(lockedManualItemToastMessage(item, lang));
      if (lockedTapNoticeTimerRef.current) clearTimeout(lockedTapNoticeTimerRef.current);
      lockedTapNoticeTimerRef.current = setTimeout(() => {
        setLockedTapNotice(null);
        lockedTapNoticeTimerRef.current = null;
      }, 4800);
    },
    [lang],
  );

  useEffect(() => {
    return () => {
      if (lockedTapNoticeTimerRef.current) clearTimeout(lockedTapNoticeTimerRef.current);
    };
  }, []);

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
      } else setError(data?.message ?? t("errorRefresh", lang));
    } finally { setR(false); }
  }, [lang]);

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
          setSelectionNotice(t("maxItemsPerSide", lang).replace("{n}", String(MAX_TRADE_ITEMS_PER_SIDE)));
          window.setTimeout(() => setSelectionNotice(null), 2800);
        });
        return prev;
      }
      const n = new Set(prev);
      n.add(id);
      return n;
    });
  }, [lang]);

  // ------ computed ------
  const selMyItems = myItems.filter((i) => selectedMy.has(i.assetId));
  const selOwnerItems = ownerItems.filter((i) => selectedOwner.has(i.assetId));
  const myTotal = selMyItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);
  const ownerTotal = selOwnerItems.reduce((s, i) => s + (i.belowThreshold ? 0 : i.priceUsd), 0);
  const tradeSelectionReady = selectedMy.size > 0 && selectedOwner.size > 0;
  const tradeBalance = tradeSelectionReady ? checkTradeBalance(myTotal, ownerTotal) : null;
  const tradeBalanceAlertText = useMemo(() => {
    if (!tradeBalance || tradeBalance.ok) return null;
    if (tradeBalance.reason === "overpay_too_low") {
      return `${t("addItemsOrRemove", lang)} ${fmt(tradeBalance.shortfallCents)} (${t("overpayNotBelow", lang)})`;
    }
    if (tradeBalance.reason === "overpay_too_high") {
      return `${t("reduceOverpayBy", lang)} ${fmt(tradeBalance.excessCents)} (${t("maxPercent", lang)} ${TRADE_MAX_OVERPAY_PERCENT}%)`;
    }
    return t("tradeNoPricing", lang);
  }, [tradeBalance, lang, fmt]);
  const overpayPct = ownerTotal > 0 ? tradeOverpayPercent(myTotal, ownerTotal) ?? 0 : 0;
  const overpayBarFillPct =
    ownerTotal <= 0 ? 0 : overpayPct < 0 ? 0 : Math.min(100, (overpayPct / TRADE_MAX_OVERPAY_PERCENT) * 100);
  const overpayBarColor =
    overpayPct < 0 ? "#f97316" : overpayPct > TRADE_MAX_OVERPAY_PERCENT ? "#ef4444" : "#22c55e";
  const overpayWordColor =
    overpayPct < 0 || overpayPct > TRADE_MAX_OVERPAY_PERCENT
      ? "text-red-400"
      : "text-emerald-500";
  const canSubmit = tradeSelectionReady && tradeBalance?.ok === true && !tradeModalBusy;

  useLayoutEffect(() => {
    const el = overpayBarFillRef.current;
    if (!el) return;
    el.style.setProperty("--trade-overpay-bar-width", `${overpayBarFillPct}%`);
    el.style.setProperty("--trade-overpay-bar-color", overpayBarColor);
  }, [overpayBarFillPct, overpayBarColor]);

  const requirementRows: { done: boolean; text: string; issue?: boolean }[] = [
    { done: selectedMy.size > 0, text: t("addYourItems", lang) },
    { done: selectedOwner.size > 0, text: t("selectStoreItems", lang) },
  ];
  if (tradeBalance && !tradeBalance.ok) {
    if (tradeBalance.reason === "overpay_too_high") {
      requirementRows.push({
        done: false,
        issue: true,
        text: `${t("reduceOverpayBy", lang)} ${fmt(tradeBalance.excessCents)} (${t("maxPercent", lang)} ${TRADE_MAX_OVERPAY_PERCENT}%)`,
      });
    } else if (tradeBalance.reason === "overpay_too_low") {
      requirementRows.push({
        done: false,
        issue: true,
        text: `${t("addItemsOrRemove", lang)} ${fmt(tradeBalance.shortfallCents)} (${t("overpayNotBelow", lang)})`,
      });
    } else {
      requirementRows.push({ done: false, issue: true, text: t("tradeNoPricing", lang) });
    }
  }
  const pendingRequirements = requirementRows.filter((r) => !r.done).length;

  function matchesInvFilters(item: InventoryItem): boolean {
    if (isStatTrakItem(item) && !invShowStatTrak) return false;
    if (isSouvenirItem(item) && !invShowSouvenir) return false;
    if (isItemTradeLocked(item) && !invShowTradeLocked) return false;

    const minC = parseUsdToCentsBound(invPriceMinStr);
    const maxC = parseUsdToCentsBound(invPriceMaxStr);
    if (minC != null && item.priceUsd < minC) return false;
    if (maxC != null && item.priceUsd > maxC) return false;

    const floatActive = invFloatMin > 0 || invFloatMax < 1;
    if (floatActive) {
      if (item.floatValue == null) return false;
      if (item.floatValue < invFloatMin || item.floatValue > invFloatMax) return false;
    }
    return true;
  }

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

  /** Store inventory: one list; same primary sort as UI; locked only as tiebreaker (below at equal price/name/float). */
  function sortOwnerItems(items: InventoryItem[], s: string) {
    const lockRank = (i: InventoryItem) => (i.locked === true ? 1 : 0);
    return [...items].sort((a, b) => {
      let cmp = 0;
      switch (s) {
        case "price-desc":
          cmp = b.priceUsd - a.priceUsd;
          break;
        case "price-asc":
          cmp = a.priceUsd - b.priceUsd;
          break;
        case "name-asc":
          cmp = a.name.localeCompare(b.name);
          break;
        case "name-desc":
          cmp = b.name.localeCompare(a.name);
          break;
        case "float-asc":
          cmp = (a.floatValue ?? 1) - (b.floatValue ?? 1);
          break;
        case "float-desc":
          cmp = (b.floatValue ?? 0) - (a.floatValue ?? 0);
          break;
        default:
          cmp = 0;
      }
      if (cmp !== 0) return cmp;
      return lockRank(a) - lockRank(b);
    });
  }

  function filterMy(items: InventoryItem[], q: string, s: string) {
    let r = items;
    if (q.trim()) { const ql = q.toLowerCase(); r = r.filter((i) => i.name.toLowerCase().includes(ql) || i.marketHashName.toLowerCase().includes(ql)); }
    r = r.filter(matchesInvFilters);
    return sortItems(r, s);
  }

  function filterOwner(items: InventoryItem[], q: string, s: string) {
    let r = items;
    if (q.trim()) { const ql = q.toLowerCase(); r = r.filter((i) => i.name.toLowerCase().includes(ql) || i.marketHashName.toLowerCase().includes(ql)); }
    r = r.filter(matchesInvFilters);
    if (category === "Weapon") {
      r = r.filter((i) => WEAPON_TYPES.some((wt) => i.type?.includes(wt)));
    } else if (category !== "All") {
      r = r.filter((i) => i.type?.includes(category));
    }
    if (wear !== "All") r = r.filter((i) => i.wear === wear);
    return sortOwnerItems(r, s);
  }

  return (
    <div className="scheme-dark flex min-h-screen min-w-0 flex-col overflow-x-hidden bg-[#0d0d0f] text-zinc-100">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 bg-[#111113] px-4 py-2 sm:px-5">
        <a href="/" className="text-base font-bold tracking-tight text-amber-500">CHEZ<span className="text-zinc-300">TRADING</span></a>
        <nav className="flex items-center gap-4 text-sm text-zinc-500 sm:gap-5">
          <span className="text-amber-500/90">{t("cs2Trade", lang)}</span>
          {isLoggedIn ? (
            <Link href="/trades" className="hover:text-amber-400/90">
              {t("myTrades", lang)}
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-3">
          <LangCurrencyPicker
            lang={lang}
            onLangChange={setLang}
            currency={currency}
            onCurrencyChange={setCurrency}
          />
          {!isLoggedIn ? (
            <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 transition-colors">
              {t("loginSteam", lang)}
            </a>
          ) : (
            <a href="/api/auth/logout" className="text-xs text-zinc-500 hover:text-zinc-300">{t("logout", lang)}</a>
          )}
        </div>
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
          {t("signedIn", lang)}
        </div>
      ) : null}

      {selectionNotice ? (
        <div className="border-b border-amber-800/40 bg-amber-950/25 px-5 py-2 text-sm text-amber-200" role="status">
          {selectionNotice}
        </div>
      ) : null}

      {lockedTapNotice ? (
        <div
          className="border-b border-orange-800/45 bg-orange-950/35 px-5 py-2.5 text-sm leading-snug text-orange-100"
          role="status"
        >
          {lockedTapNotice}
        </div>
      ) : null}

      {/* Messages */}
      {error && <div className="bg-red-900/30 border-b border-red-800/40 px-5 py-2 text-sm text-red-400">{error}</div>}
      {tradeSubmitError && (
        <div className="border-b border-red-800/40 bg-red-950/40 px-5 py-2 text-sm text-red-300" role="alert">
          {tradeSubmitError}
        </div>
      )}

      {/* Main: flex-1 + min-h-0 so columns can shrink and scroll; page grows past 100vh when needed (zoom / many banners) */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* 3-Column Layout — internal scroll via .trade-scroll; footer stays in document flow below */}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,39%)_minmax(0,22%)_minmax(0,39%)] grid-rows-[minmax(0,1fr)] items-stretch overflow-hidden">
        {/* ─── LEFT: Your Inventory ─── */}
        <div className="flex min-h-0 min-w-0 flex-col justify-start border-r border-zinc-800/50">
          {/* Selected items strip */}
          <SelectedStrip
            label={t("youGive", lang)}
            sublabel={t("yourInventory", lang)}
            items={selMyItems}
            total={myTotal}
            onRemove={(id) => toggle(setSelectedMy, id)}
            count={selectedMy.size}
            maxPerSide={MAX_TRADE_ITEMS_PER_SIDE}
            fmt={fmt}
            lang={lang}
          />

          {/* Content — each branch gets flex-1 + overflow-y-auto so it always fills the column */}
          {!authReady ? (
            <div className="flex min-h-0 flex-col">
              <PanelHeader
                search={mySearch}
                onSearch={setMySearch}
                sort={mySort}
                onSort={setMySort}
                prefix="my"
                onRefresh={() => doRefresh("my", setMyRefreshing, setMyCooldown, loadMyInventory)}
                refreshing={myRefreshing}
                cooldown={myCooldown}
                lang={lang}
                controlsDisabled
              />
              <div className="trade-scroll trade-inventory-scroll px-1.5 py-1 sm:px-2 sm:py-1.5">
                <ItemGridSkeleton lang={lang} />
              </div>
            </div>
          ) : !isLoggedIn ? (
            <div className="trade-scroll trade-inventory-scroll flex flex-col items-center justify-start gap-4 px-6 pb-6 pt-4 text-center">
              <div className="text-5xl opacity-20">🎮</div>
              <p className="max-w-xs text-sm text-zinc-500">{t("loginPrompt", lang)}</p>
              <a href="/api/auth/steam" className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-semibold text-white hover:bg-amber-500">
                {t("loginSteam", lang)}
              </a>
            </div>
          ) : !hasTradeUrl || editingTradeUrl ? (
            <div className="trade-scroll trade-inventory-scroll">
              <div className="flex flex-col items-center gap-4 px-6 pb-6 pt-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-600/20 text-2xl">🔗</div>
                <h3 className="text-base font-bold text-zinc-100">
                  {hasTradeUrl ? t("updateTradeUrl", lang) : t("pasteTradeUrl", lang)}
                </h3>
                <p className="max-w-xs text-center text-xs text-zinc-500">
                  {t("tradeUrlHint", lang)} <strong className="text-zinc-400">{t("onlyYourOwn", lang)}</strong>
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
                      {t("saveAndLoad", lang)}
                    </button>
                    {hasTradeUrl && (
                      <button onClick={() => setEditingTradeUrl(false)} className="rounded-lg border border-zinc-700 px-4 py-2.5 text-xs text-zinc-400 hover:text-zinc-200">
                        {t("cancel", lang)}
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
                  {t("whereTradeUrl", lang)}
                </a>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col">
              <PanelHeader
                search={mySearch}
                onSearch={setMySearch}
                sort={mySort}
                onSort={setMySort}
                prefix="my"
                onRefresh={() => doRefresh("my", setMyRefreshing, setMyCooldown, loadMyInventory)}
                refreshing={myRefreshing}
                cooldown={myCooldown}
                tradeUrlAction={() => setEditingTradeUrl(true)}
                lang={lang}
                controlsDisabled={myInventoryLoading}
              />
              <div className="trade-scroll trade-inventory-scroll px-1.5 py-1 sm:px-2 sm:py-1.5">
                {myInventoryLoading ? (
                  <ItemGridSkeleton lang={lang} />
                ) : (
                  <ItemGrid
                    items={filterMy(myItems, mySearch, mySort)}
                    side="guest"
                    selected={selectedMy}
                    onToggle={(id) => toggle(setSelectedMy, id)}
                    fmt={fmt}
                    lang={lang}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* ─── CENTER: h-full so inner flex-1 consumes full grid cell (same height as side columns) ─── */}
        <div className="@container flex h-full min-h-0 min-w-0 flex-col bg-[#111113]">
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-1.5 py-1.5 sm:gap-2 sm:px-2 sm:py-2">
            {/* Trade analysis */}
            <div className="grid min-w-0 grid-cols-2 gap-1">
              <div className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-1.5 py-1 text-center">
                <div className="mb-px truncate text-[8px] text-zinc-500 sm:text-[9px]">{t("youGive", lang)}</div>
                <p className="truncate text-[11px] font-bold tabular-nums text-zinc-100 sm:text-xs">{fmt(myTotal)}</p>
              </div>
              <div className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-1.5 py-1 text-center">
                <div className="mb-px truncate text-[8px] text-zinc-500 sm:text-[9px]">{t("youGet", lang)}</div>
                <p className="truncate text-[11px] font-bold tabular-nums text-zinc-100 sm:text-xs">{fmt(ownerTotal)}</p>
              </div>
            </div>

            {tradeBalanceAlertText && tradeSelectionReady ? (
              <div
                className="flex min-w-0 gap-1 rounded-lg border border-amber-700/35 bg-zinc-900/90 px-1.5 py-1.5 text-[9px] leading-snug text-amber-100/95 sm:text-[10px]"
                role="alert"
              >
                <span className="shrink-0 text-amber-500" aria-hidden>
                  ⚠
                </span>
                <p className="min-w-0 break-words">{tradeBalanceAlertText}</p>
              </div>
            ) : null}

            {/* Overpay + Submit — column in narrow center so text fits without horizontal clip */}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="@[240px]:flex-row flex min-w-0 flex-col gap-1 @[240px]:items-stretch">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-1.5 py-1">
                  <div className="flex min-w-0 items-center justify-between gap-1">
                    <span className={`shrink-0 text-[9px] font-semibold ${overpayWordColor}`}>{t("overpay", lang)}</span>
                    <span
                      className={`min-w-0 truncate text-right text-[10px] font-bold tabular-nums ${
                        overpayPct < 0
                          ? "text-orange-400"
                          : overpayPct > TRADE_MAX_OVERPAY_PERCENT
                            ? "text-red-400"
                            : "text-emerald-400/90"
                      }`}
                    >
                      {overpayPct > 0 ? "+" : ""}
                      {overpayPct.toFixed(1)}%
                      <span className="ml-0.5 text-[8px] font-normal text-zinc-500">(0–{TRADE_MAX_OVERPAY_PERCENT}%)</span>
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      ref={overpayBarFillRef}
                      className="trade-overpay-bar-fill h-full rounded-full transition-[width,background-color] duration-300"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={openTradeSubmitModal}
                  disabled={!canSubmit}
                  className={`w-full shrink-0 rounded-lg px-2 py-2 text-center text-[10px] font-bold leading-tight transition-all @[240px]:w-auto @[240px]:self-center @[240px]:px-3 @[240px]:py-2.5 @[240px]:text-xs ${
                    canSubmit
                      ? "bg-amber-600 text-white shadow-lg shadow-amber-600/20 hover:bg-amber-500 active:scale-[0.98]"
                      : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                  }`}
                >
                  {t("submitTrade", lang)}
                </button>
              </div>
            </div>

            {/* Market info (reference-style) */}
            <div className="flex min-w-0 flex-col items-stretch gap-1" role="note">
              <div className="w-full rounded-lg border border-amber-900/25 bg-[#0c0c0e] px-1.5 py-1.5 text-center text-[8px] font-medium leading-snug text-amber-500 sm:text-[9px]">
                {t("marketWarning", lang)}
              </div>
              <p className="w-full text-balance text-center text-[8px] leading-snug text-zinc-500 sm:text-[9px]">
                {t("priceDisclaimer", lang)}
              </p>
            </div>

            {/* Divider */}
            <div className="border-t border-zinc-800/50" />

            {/* StatTrak / Souvenir / trade lock + price + float (client-side, both inventories) */}
            <div className="min-w-0 space-y-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-2 py-2">
              <div className="flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-[9px] text-zinc-300 sm:text-[10px]">
                  <input
                    type="checkbox"
                    checked={invShowStatTrak}
                    onChange={(e) => setInvShowStatTrak(e.target.checked)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 accent-amber-500"
                  />
                  {t("invFilterStatTrak", lang)}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[9px] text-zinc-300 sm:text-[10px]">
                  <input
                    type="checkbox"
                    checked={invShowSouvenir}
                    onChange={(e) => setInvShowSouvenir(e.target.checked)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 accent-amber-500"
                  />
                  {t("invFilterSouvenir", lang)}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[9px] text-zinc-300 sm:text-[10px]">
                  <input
                    type="checkbox"
                    checked={invShowTradeLocked}
                    onChange={(e) => setInvShowTradeLocked(e.target.checked)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-zinc-600 bg-zinc-900 accent-amber-500"
                  />
                  {t("invFilterTradeLocked", lang)}
                </label>
              </div>
              <div>
                <h4 className="mb-1 text-[9px] font-semibold text-zinc-400 sm:text-[10px]">{t("invFilterPriceRange", lang)}</h4>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={t("invFilterMin", lang)}
                    value={invPriceMinStr}
                    onChange={(e) => setInvPriceMinStr(e.target.value)}
                    className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-100 sm:text-[10px]"
                  />
                  <span className="shrink-0 text-zinc-500">—</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder={t("invFilterMax", lang)}
                    value={invPriceMaxStr}
                    onChange={(e) => setInvPriceMaxStr(e.target.value)}
                    className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-100 sm:text-[10px]"
                  />
                </div>
              </div>
              <div>
                <h4 className="mb-1 text-[9px] font-semibold text-zinc-400 sm:text-[10px]">{t("invFilterFloatRange", lang)}</h4>
                <div
                  className="mb-1.5 h-2 w-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-red-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
                  aria-hidden
                />
                <div className="flex flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="w-7 shrink-0 text-[8px] text-zinc-500">{t("invFilterMin", lang)}</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.001}
                      value={invFloatMin}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const x = Math.max(0, Math.min(1, v));
                        setInvFloatMin(Math.min(x, invFloatMax));
                      }}
                      aria-label={`${t("invFilterFloatRange", lang)} — ${t("invFilterMin", lang)}`}
                      className="w-[4.25rem] shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[9px] text-zinc-100"
                    />
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      step={1}
                      value={Math.round(invFloatMin * 1000)}
                      onChange={(e) => {
                        const step = Number(e.target.value);
                        setInvFloatMin(Math.min(step / 1000, invFloatMax));
                      }}
                      aria-label={`${t("invFilterFloatRange", lang)} — ${t("invFilterMin", lang)}`}
                      className="min-w-0 flex-1 accent-emerald-500"
                    />
                  </div>
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="w-7 shrink-0 text-[8px] text-zinc-500">{t("invFilterMax", lang)}</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.001}
                      value={invFloatMax}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isFinite(v)) return;
                        const x = Math.max(0, Math.min(1, v));
                        setInvFloatMax(Math.max(x, invFloatMin));
                      }}
                      aria-label={`${t("invFilterFloatRange", lang)} — ${t("invFilterMax", lang)}`}
                      className="w-[4.25rem] shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[9px] text-zinc-100"
                    />
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      step={1}
                      value={Math.round(invFloatMax * 1000)}
                      onChange={(e) => {
                        const step = Number(e.target.value);
                        setInvFloatMax(Math.max(step / 1000, invFloatMin));
                      }}
                      aria-label={`${t("invFilterFloatRange", lang)} — ${t("invFilterMax", lang)}`}
                      className="min-w-0 flex-1 accent-red-500"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Item Type Categories — 2 cols, truncate to avoid horizontal overflow */}
            <div className="min-w-0">
              <h4 className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold text-zinc-400 sm:text-[10px]">
                <span className="shrink-0 text-amber-500">◈</span>
                <span className="min-w-0 truncate">{t("itemType", lang)}</span>
              </h4>
              <div className="grid min-w-0 grid-cols-2 gap-0.5">
                {CATEGORY_KEYS.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setCategory(cat.key)}
                    className={`flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[9px] leading-tight transition-all sm:text-[10px] ${
                      category === cat.key
                        ? "border border-amber-600/40 bg-amber-600/20 font-semibold text-amber-400"
                        : "border border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                    }`}
                  >
                    <span className="shrink-0 text-xs sm:text-sm">{cat.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{t(cat.i18n, lang)}</span>
                    {category === cat.key && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
                  </button>
                ))}
              </div>
            </div>

            {/* Wear filter */}
            <div className="min-w-0">
              <h4 className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold text-zinc-400 sm:text-[10px]">
                <span className="shrink-0 text-amber-500">◈</span>
                <span className="min-w-0 truncate">{t("wearLabel", lang)}</span>
              </h4>
              <div className="flex min-w-0 flex-wrap gap-0.5">
                <button
                  type="button"
                  onClick={() => setWear("All")}
                  className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors sm:text-[10px] ${
                    wear === "All" ? "border border-amber-600/40 bg-amber-600/20 text-amber-400" : "border border-zinc-800/60 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {t("wearAll", lang)}
                </button>
                {WEAR_LABELS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWear(w)}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors sm:text-[10px] ${
                      wear === w ? "border border-amber-600/40 bg-amber-600/20 text-amber-400" : "border border-zinc-800/60 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {WEAR_SHORT[w]}
                  </button>
                ))}
              </div>
            </div>

            {/* Requirements */}
            <div className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/50 px-1.5 py-1.5">
              {pendingRequirements > 0 ? (
                <p className="mb-0.5 break-words text-[8px] font-semibold uppercase tracking-wide text-zinc-500 sm:text-[9px]">
                  {requirementsHeading(pendingRequirements, lang)}
                </p>
              ) : null}
              <div className="space-y-1">
                {requirementRows.map((row, idx) => (
                  <ReqLine key={`req-${idx}`} done={row.done} text={row.text} issue={row.issue} compact />
                ))}
              </div>
            </div>

            {/* Fills remaining grid-cell height; panel + disclaimer so the strip isn’t an empty void */}
            <div className="flex min-h-0 flex-1 flex-col justify-start rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-2 py-2 sm:px-2.5 sm:py-2">
              <p className="text-balance text-left text-[9px] font-medium leading-snug text-zinc-500 sm:text-[10px] sm:leading-snug">
                {t("centerPanelFiller", lang)}
              </p>
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Store Inventory ─── */}
        <div className="flex min-h-0 min-w-0 flex-col justify-start border-l border-zinc-800/50">
          <SelectedStrip
            label={t("youGet", lang)}
            sublabel={t("platformInventory", lang)}
            items={selOwnerItems}
            total={ownerTotal}
            onRemove={(id) => toggle(setSelectedOwner, id)}
            count={selectedOwner.size}
            maxPerSide={MAX_TRADE_ITEMS_PER_SIDE}
            isRight
            fmt={fmt}
            lang={lang}
          />

          <PanelHeader
            search={ownerSearch}
            onSearch={setOwnerSearch}
            sort={ownerSort}
            onSort={setOwnerSort}
            prefix="owner"
            onRefresh={() => doRefresh("owner", setOwnerRefreshing, setOwnerCooldown, loadOwner)}
            refreshing={ownerRefreshing}
            cooldown={ownerCooldown}
            lang={lang}
            controlsDisabled={ownerInventoryLoading}
            showRefreshButton={isAdmin}
          />
          <div className="trade-scroll trade-inventory-scroll px-1.5 py-1 sm:px-2 sm:py-1.5">
            {ownerInventoryLoading ? (
              <ItemGridSkeleton lang={lang} />
            ) : (
              <ItemGrid
                items={filterOwner(ownerItems, ownerSearch, ownerSort)}
                side="owner"
                selected={selectedOwner}
                onToggle={(id) => toggle(setSelectedOwner, id)}
                onLockedItemClick={showLockedTapNotice}
                showAssetId={isAdmin}
                fmt={fmt}
                lang={lang}
              />
            )}
          </div>
        </div>
        </div>
      </main>

      {/* Footer — normal flow; mt-auto pins to bottom when main is shorter than viewport */}
      <footer className="mt-auto w-full shrink-0 border-t border-zinc-800/60 bg-[#0a0a0c] px-3 py-2 sm:px-5 sm:py-2.5 lg:px-8">
        <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0 shrink-0 sm:max-w-[32%]">
            <span className="text-xs font-bold tracking-tight text-amber-500 sm:text-sm">CHEZ<span className="text-zinc-400">TRADING</span></span>
            <p className="mt-0.5 max-w-full text-balance text-[9px] leading-snug text-zinc-600 sm:text-[10px]">
              © 2024–{new Date().getFullYear()} ChezTrading. {t("footerRights", lang)}
            </p>
          </div>

          <nav
            className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[9px] text-zinc-600 sm:justify-center sm:gap-x-5 sm:text-[10px] lg:gap-x-6"
            aria-label="Legal"
          >
            <span className="shrink-0 cursor-default hover:text-zinc-400">{t("footerTos", lang)}</span>
            <span className="shrink-0 cursor-default hover:text-zinc-400">{t("footerPrivacy", lang)}</span>
            <Link href="/cookies" className="shrink-0 text-zinc-600 hover:text-zinc-400">
              {t("footerCookies", lang)}
            </Link>
          </nav>

          <div className="min-w-0 shrink-0 text-center sm:max-w-[32%] sm:text-right">
            <p className="text-[9px] text-zinc-600 sm:text-[10px]">
              Support: <span className="break-all text-zinc-500">support@cheztrading.com</span>
            </p>
          </div>
        </div>

        <div className="mt-2 w-full min-w-0 border-t border-zinc-800/40 px-1 pt-2 text-center text-[8px] leading-snug text-zinc-700 sm:mt-2.5 sm:px-3 sm:pt-2 sm:text-[9px]">
          <span className="text-balance">{t("footerValve", lang)}</span>
        </div>
      </footer>

      {tradeSubmitModalOpen ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-6">
          <button
            type="button"
            className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
            aria-label={t("tradeSubmitBackdropClose", lang)}
            onClick={() => {
              if (tradeSubmitModalPhase === "manual_checklist") return;
              closeTradeSubmitModal();
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-submit-modal-title"
            className={`relative z-[201] w-full overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#141416] shadow-2xl shadow-black/60 ${
              tradeSubmitModalPhase === "manual_checklist" ? "max-h-[min(92dvh,840px)] max-w-3xl overflow-y-auto" : "max-w-md"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 sm:px-5">
              <h2 id="trade-submit-modal-title" className="min-w-0 pr-2 text-sm font-semibold text-zinc-100 sm:text-base">
                {tradeSubmitModalPhase === "pick"
                  ? t("tradeSubmitModalTitle", lang)
                  : tradeSubmitModalPhase === "manual_checklist"
                    ? `${t("tradeSubmitManualOrderPrefix", lang)}${tradeModalCreatedId ? ` #${tradeModalCreatedId}` : ""}`
                    : t("tradeSubmitSuccessHeading", lang)}
              </h2>
              {tradeSubmitModalPhase !== "manual_checklist" ? (
                <button
                  type="button"
                  onClick={closeTradeSubmitModal}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label={t("tradeSubmitModalClose", lang)}
                >
                  ×
                </button>
              ) : (
                <span className="w-8 shrink-0" aria-hidden />
              )}
            </div>

            <div className="px-4 py-4 sm:px-5 sm:py-5">
              {tradeSubmitModalPhase === "pick" ? (
                <>
                  {tradeModalError ? (
                    <p className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                      {tradeModalError}
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      disabled={tradeModalBusy}
                      onClick={() => void handleTradeModalManual()}
                      className="flex w-full flex-col items-center rounded-xl border border-amber-700/50 bg-amber-600/15 px-4 py-3.5 text-center transition-all hover:border-amber-500/60 hover:bg-amber-600/25 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="text-sm font-bold text-amber-400 sm:text-base">
                        {t("tradeSubmitManualBtn", lang)}
                      </span>
                      <span className="mt-1 text-[11px] leading-snug text-zinc-500 sm:text-xs">
                        {t("tradeSubmitManualHint", lang)}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={tradeModalBusy}
                      onClick={() => void handleTradeModalSite()}
                      className="flex w-full flex-col items-center rounded-xl border border-zinc-600 bg-zinc-800/80 px-4 py-3.5 text-center transition-all hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="text-sm font-bold text-zinc-100 sm:text-base">
                        {t("tradeSubmitSiteBtn", lang)}
                      </span>
                      <span className="mt-1 text-[11px] leading-snug text-zinc-500 sm:text-xs">
                        {t("tradeSubmitSiteHint", lang)}
                      </span>
                    </button>
                  </div>
                  {tradeModalBusy ? (
                    <p className="mt-4 text-center text-xs text-zinc-500">{t("sending", lang)}</p>
                  ) : null}
                </>
              ) : tradeSubmitModalPhase === "manual_checklist" ? (
                <div className="space-y-4">
                  <p className="text-xs leading-relaxed text-zinc-400 sm:text-sm">{t("tradeSubmitManualChecklistLead", lang)}</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3">
                      <p className="text-xs font-bold text-zinc-200">{t("tradeSubmitManualYourItemsHeading", lang)}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-500">{t("tradeSubmitManualYourItemsSub", lang)}</p>
                      <div className="mt-3 max-h-[min(38vh,320px)] space-y-2 overflow-y-auto pr-0.5">
                        {manualChecklistGuest.length === 0 ? (
                          <p className="text-[11px] text-zinc-600">—</p>
                        ) : (
                          manualChecklistGuest.map((it) => (
                            <TradeManualChecklistItemRow key={it.assetId} item={it} fmt={fmt} lang={lang} />
                          ))
                        )}
                      </div>
                    </div>
                    <div className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3">
                      <p className="text-xs font-bold text-zinc-200">{t("tradeSubmitManualStoreItemsHeading", lang)}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-500">{t("tradeSubmitManualStoreItemsSub", lang)}</p>
                      <div className="mt-3 max-h-[min(38vh,320px)] space-y-2 overflow-y-auto pr-0.5">
                        {manualChecklistOwner.length === 0 ? (
                          <p className="text-[11px] text-zinc-600">—</p>
                        ) : (
                          manualChecklistOwner.map((it) => (
                            <TradeManualChecklistItemRow key={it.assetId} item={it} fmt={fmt} lang={lang} />
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="text-center text-[11px] leading-snug text-zinc-500">{t("tradeSubmitManualConfirmHint", lang)}</p>
                  <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
                    {tradeModalCreatedId ? (
                      <Link
                        href={`/trades/${tradeModalCreatedId}`}
                        className="inline-flex justify-center rounded-lg border border-zinc-600 bg-zinc-800/80 px-4 py-2.5 text-center text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
                      >
                        {t("tradeSubmitManualViewHistory", lang)}
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      onClick={closeTradeSubmitModal}
                      className="inline-flex justify-center rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500"
                    >
                      {t("tradeSubmitManualConfirmBtn", lang)}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 text-center">
                  <p className="text-sm leading-relaxed text-zinc-200 sm:text-base">{t("tradeSubmitSiteDone", lang)}</p>
                  {tradeModalCreatedId ? (
                    <Link
                      href={`/trades/${tradeModalCreatedId}`}
                      className="inline-flex rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500"
                    >
                      {t("tradeSubmitOpenRequest", lang)}
                    </Link>
                  ) : null}
                  <div>
                    <button
                      type="button"
                      onClick={closeTradeSubmitModal}
                      className="text-sm text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
                    >
                      {t("tradeSubmitModalClose", lang)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected Items Strip (top of each side panel)
// ---------------------------------------------------------------------------

function SelectedStrip({
  label, sublabel, items, total, onRemove, count, maxPerSide, isRight, fmt: fmtFn, lang: l,
}: {
  label: string; sublabel: string; items: InventoryItem[]; total: number;
  onRemove: (id: string) => void; count: number; maxPerSide: number; isRight?: boolean;
  fmt: (cents: number) => string; lang: LangCode;
}) {
  return (
    <div className="shrink-0 border-b border-zinc-800/50 bg-[#111113] px-2.5 py-1.5 sm:px-3 sm:py-2">
      <div className="mb-1 flex items-center justify-between gap-1.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-bold ${count > 0 ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-500"}`}
              title={`${t("selected", l)} ${count} ${t("of", l)} ${maxPerSide}`}
            >
              {count}/{maxPerSide}
            </span>
            <span className="text-xs font-semibold text-zinc-200 sm:text-[13px]">{label}</span>
          </div>
          <p className="mt-px truncate text-[9px] text-zinc-600 sm:text-[10px]">{sublabel}</p>
        </div>
        {total > 0 && <span className="shrink-0 text-xs font-bold tabular-nums text-amber-400 sm:text-sm">{fmtFn(total)}</span>}
      </div>
      <div
        className="trade-scroll h-[min(100px,18vh)] w-full shrink-0 overflow-y-auto overflow-x-hidden overscroll-y-contain pr-0.5 [scrollbar-gutter:stable]"
        onWheel={(e) => e.stopPropagation()}
      >
        {items.length === 0 ? (
          <div className="flex h-full min-h-[2.5rem] items-center justify-center px-1 py-0.5">
            <p className="text-center text-[9px] leading-tight text-zinc-600 sm:text-[10px]">{isRight ? t("itemsNotSelected", l) : t("selectItemsForTrade", l)}</p>
          </div>
        ) : (
          <div className="flex w-full flex-wrap content-start gap-1.5 py-0.5">
            {items.map((item) => (
              <button
                key={item.assetId}
                type="button"
                onClick={() => onRemove(item.assetId)}
                title={`${item.name} — ${t("removeFromSelection", l)}`}
                className="group relative rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111113]"
              >
                <div className="relative h-10 w-10 overflow-hidden rounded-md border border-zinc-700/50 bg-zinc-800/50 p-0.5 transition-[border-color,box-shadow] group-hover:border-amber-500/45 group-hover:shadow-[0_0_0_1px_rgba(245,158,11,0.2)] group-active:scale-[0.97] sm:h-11 sm:w-11">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.iconUrl} alt="" className="h-full w-full object-contain" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Language & Currency Picker
// ---------------------------------------------------------------------------

function LangCurrencyPicker({
  lang, onLangChange, currency, onCurrencyChange,
}: {
  lang: LangCode; onLangChange: (v: LangCode) => void;
  currency: CurrencyCode; onCurrencyChange: (v: CurrencyCode) => void;
}) {
  const [langOpen, setLangOpen] = useState(false);
  const [curOpen, setCurOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (curRef.current && !curRef.current.contains(e.target as Node)) setCurOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const curLang = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];
  const curCur = CURRENCIES.find((c) => c.code === currency) ?? CURRENCIES[0];

  return (
    <div className="flex items-center gap-1.5">
      {/* Language */}
      <div className="relative" ref={langRef}>
        <button
          type="button"
          onClick={() => { setLangOpen((v) => !v); setCurOpen(false); }}
          className="flex items-center gap-1 rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition-colors"
        >
          <span className="text-sm">{curLang.flag}</span>
          <svg className="h-3 w-3 text-zinc-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
        </button>
        {langOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[130px] rounded-lg border border-zinc-700/60 bg-zinc-900 py-1 shadow-xl">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => { onLangChange(l.code); setLangOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  lang === l.code ? "bg-amber-600/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <span className="text-sm">{l.flag}</span>
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Currency */}
      <div className="relative" ref={curRef}>
        <button
          type="button"
          onClick={() => { setCurOpen((v) => !v); setLangOpen(false); }}
          className="flex items-center gap-1 rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition-colors"
        >
          <span className="text-[11px] font-medium">{curCur.symbol}</span>
          <span className="text-[11px]">{curCur.code}</span>
          <svg className="h-3 w-3 text-zinc-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
        </button>
        {curOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[130px] rounded-lg border border-zinc-700/60 bg-zinc-900 py-1 shadow-xl">
            {CURRENCIES.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => { onCurrencyChange(c.code); setCurOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  currency === c.code ? "bg-amber-600/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <span className="text-sm">{c.flag}</span>
                <span className="font-medium">{c.symbol}</span>
                {c.code}
              </button>
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

function ReqLine({ done, text, issue, compact }: { done: boolean; text: string; issue?: boolean; compact?: boolean }) {
  return (
    <div className={`flex items-start gap-1.5 ${compact ? "text-[10px] leading-snug" : "text-xs"}`}>
      <span
        className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full font-bold ${
          compact ? "h-3.5 w-3.5 text-[8px]" : "h-4 w-4 text-[9px]"
        } ${
          done
            ? "bg-emerald-600 text-white"
            : issue
              ? "border border-red-800/50 bg-red-950/40 text-red-400"
              : "bg-zinc-800 text-zinc-500"
        }`}
      >
        {done ? "✓" : issue ? "−" : "+"}
      </span>
      <span
        className={`min-w-0 break-words ${done ? "text-zinc-400 line-through" : issue ? "text-red-300/90" : "text-zinc-400"}`}
      >
        {text}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel Header (search + sort + refresh)
// ---------------------------------------------------------------------------

function PanelHeader({
  search, onSearch, sort, onSort, prefix,
  onRefresh, refreshing, cooldown, tradeUrlAction, lang: l,
  controlsDisabled,
  showRefreshButton = true,
}: {
  search: string; onSearch: (v: string) => void;
  sort: string; onSort: (v: string) => void;
  prefix: string;
  onRefresh: () => void; refreshing: boolean; cooldown: number;
  tradeUrlAction?: () => void; lang: LangCode;
  controlsDisabled?: boolean;
  /** Store inventory: only admins see manual Steam refresh. */
  showRefreshButton?: boolean;
}) {
  const frozen = !!controlsDisabled;
  return (
    <div className="border-b border-zinc-800/50 bg-[#0f0f11] px-2.5 py-1.5 sm:px-3 sm:py-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 text-xs">🔍</span>
          <input
            type="text"
            placeholder={t("searchPlaceholder", l)}
            className="w-full rounded-lg border border-zinc-800/60 bg-zinc-900/60 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-amber-700/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            disabled={frozen}
          />
        </div>
        <select
          aria-label={`${prefix}-sort`}
          className="rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          value={sort}
          onChange={(e) => onSort(e.target.value)}
          disabled={frozen}
        >
          {SORT_KEYS.map((s) => <option key={s.key} value={s.key}>{t(s.i18n, l)}</option>)}
        </select>
        {showRefreshButton ? (
          <div
            className={`relative inline-flex rounded-lg ${cooldown > 0 && !refreshing ? "group/refcd cursor-not-allowed" : ""}`}
            title={cooldown > 0 && !refreshing ? `${t("nextRefreshIn", l)} ${formatRefreshCooldown(cooldown, l)}` : undefined}
          >
            <button
              type="button"
              onClick={onRefresh}
              disabled={frozen || refreshing || cooldown > 0}
              className={`rounded-lg border p-1.5 text-xs transition-colors ${frozen || cooldown > 0 || refreshing ? "border-zinc-800 text-zinc-700 cursor-not-allowed" : "border-zinc-800/60 text-zinc-500 hover:text-zinc-300"}`}
              aria-label={cooldown > 0 ? `${t("nextRefreshIn", l)} ${formatRefreshCooldown(cooldown, l)}` : t("refreshInventory", l)}
            >
              <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
            </button>
            {cooldown > 0 && !refreshing && (
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-[min(240px,calc(100vw-24px))] -translate-x-1/2 rounded-md border border-zinc-600/90 bg-zinc-950 px-2 py-1.5 text-center text-[10px] leading-snug text-zinc-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover/refcd:opacity-100"
              >
                {t("nextRefreshIn", l)}
                <br />
                <span className="font-semibold text-amber-400/90">{formatRefreshCooldown(cooldown, l)}</span>
              </span>
            )}
          </div>
        ) : null}
        {tradeUrlAction && (
          <button
            type="button"
            onClick={tradeUrlAction}
            disabled={frozen}
            className="rounded-lg border border-zinc-800/60 p-1.5 text-[10px] text-zinc-600 hover:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
            title={t("changeTradeUrl", l)}
          >
            ⚙
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item grid skeleton (initial inventory load)
// ---------------------------------------------------------------------------

function ItemGridSkeleton({ lang: l }: { lang: LangCode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("loading", l)}
      className="space-y-2"
    >
      <span className="sr-only">{t("loading", l)}</span>
      <div
        className={`grid grid-cols-2 gap-0.5 sm:grid-cols-3 sm:gap-1 lg:grid-cols-4 xl:grid-cols-5 ${styles.skeletonGrid}`}
      >
        {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
          <div
            key={i}
            className="flex aspect-square w-full min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-800/40 bg-zinc-900/35"
          >
            <div className="flex min-h-0 flex-[7] items-center justify-center p-1">
              <div className="h-[70%] w-[70%] max-h-[120px] max-w-[120px] animate-pulse rounded-md bg-zinc-800/55" />
            </div>
            <div className="flex min-h-0 flex-[3] flex-col justify-end gap-0.5 px-1.5 pb-1.5 pt-0">
              <div className="h-2 w-full animate-pulse rounded bg-zinc-800/70" />
              <div className="h-1.5 w-2/3 animate-pulse rounded bg-zinc-800/60" />
              <div className="h-2.5 w-1/2 animate-pulse rounded bg-zinc-800/65" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Grid
// ---------------------------------------------------------------------------

function itemGridRowKey(item: InventoryItem, side: "owner" | "guest"): string {
  if (side === "owner" && item.locked) {
    return `m-${item.assetId}-${item.classId}-${item.instanceId}`;
  }
  return `${side}-${item.assetId}`;
}

function ItemGrid({
  items,
  side,
  selected,
  onToggle,
  onLockedItemClick,
  showAssetId,
  fmt: fmtFn,
  lang: l,
}: {
  items: InventoryItem[];
  side: "owner" | "guest";
  selected: Set<string>;
  onToggle: (id: string) => void;
  onLockedItemClick?: (item: InventoryItem) => void;
  showAssetId?: boolean;
  fmt: (cents: number) => string;
  lang: LangCode;
}) {
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const ownerRendersAll = side === "owner";

  useEffect(() => {
    if (ownerRendersAll) return;
    setVisibleCount(ITEMS_PER_PAGE);
  }, [items.length, ownerRendersAll]);

  useEffect(() => {
    if (ownerRendersAll) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + ITEMS_PER_PAGE, items.length));
        }
      },
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [items.length, ownerRendersAll]);

  if (items.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-zinc-600">{t("noItems", l)}</div>;
  }

  const visible = ownerRendersAll ? items : items.slice(0, visibleCount);
  const hasMore = !ownerRendersAll && visibleCount < items.length;

  return (
    <>
      <div className="grid grid-cols-2 gap-0.5 sm:grid-cols-3 sm:gap-1 lg:grid-cols-4 xl:grid-cols-5">
        {visible.map((item) => (
          <ItemCard
            key={itemGridRowKey(item, side)}
            item={item}
            isSelected={!item.locked && selected.has(item.assetId)}
            onToggle={() => onToggle(item.assetId)}
            onLockedItemClick={side === "owner" ? onLockedItemClick : undefined}
            showAssetId={!!showAssetId && side === "owner"}
            fmt={fmtFn}
            lang={l}
          />
        ))}
      </div>
      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-6 text-xs text-zinc-600">
          {t("loadingItems", l)} ({visible.length} / {items.length})
        </div>
      )}
      {!hasMore && !ownerRendersAll && items.length > ITEMS_PER_PAGE && (
        <div className="py-4 text-center text-[11px] text-zinc-600">
          {t("allItemsLoaded", l)} ({items.length})
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Item Card
// ---------------------------------------------------------------------------

function stickerLabel(s: { name: string }, i: number, l: LangCode): string {
  const txt = s.name?.trim();
  if (txt) return txt;
  return `${t("stickerN", l)} ${i + 1}`;
}

function RarityBar({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.style.setProperty("--rc", color); }, [color]);
  return <div ref={ref} className={`absolute inset-x-0 bottom-0 h-[2px] ${styles.rarityBar}`} />;
}

function floatBarColor(f: number): string {
  if (f < 0.07) return "#22c55e";
  if (f < 0.15) return "#84cc16";
  if (f < 0.38) return "#eab308";
  if (f < 0.45) return "#f97316";
  return "#ef4444";
}

/** Visible fill on 0–1 wear scale (raw % is tiny for FN floats and looked “missing” on narrow cards). */
function floatBarFillPercent(f: number): number {
  if (f == null || Number.isNaN(f) || f <= 0) return 0;
  const raw = Math.min(f * 100, 100);
  return Math.max(raw, 14);
}

/** Steam rarity hex from API; applied via CSS var so JSX has no `style={{…}}` (Edge no-inline-styles). */
function SteamRarityText({
  color,
  className,
  children,
}: {
  color: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--item-name-color", color);
  }, [color]);
  return (
    <p ref={ref} className={`${styles.itemNameDynamic} ${className}`}>
      {children}
    </p>
  );
}

function FloatBarFillInner({ floatValue }: { floatValue: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.setProperty("--float-pct", `${floatBarFillPercent(floatValue)}%`);
    ref.current.style.setProperty("--float-bg", floatBarColor(floatValue));
  }, [floatValue]);
  return <div ref={ref} className={`h-full min-w-px rounded-full ${styles.floatBarFill}`} />;
}

function InspectInGameButton({ href, lang: l }: { href: string; lang: LangCode }) {
  return (
    <a
      href={href}
      title={t("inspectInCs2", l)}
      aria-label={t("inspectInCs2", l)}
      className="absolute right-0.5 top-0.5 z-[45] flex h-6 w-6 items-center justify-center rounded-md border border-red-950/60 bg-[#2a1518]/90 text-zinc-200 shadow-sm backdrop-blur-[2px] transition-colors hover:border-amber-900/40 hover:bg-[#331a1d] hover:text-white"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.75" />
        <path d="M14.2 14.2L20 20" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        <path d="M10 7.25v5.5M7.25 10h5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </a>
  );
}

function ItemCard({ item, isSelected, onToggle, onLockedItemClick, showAssetId, fmt: fmtFn, lang: l }: {
  item: InventoryItem; isSelected: boolean; onToggle: () => void; showAssetId?: boolean;
  onLockedItemClick?: (item: InventoryItem) => void;
  fmt: (cents: number) => string; lang: LangCode;
}) {
  const [assetCopied, setAssetCopied] = useState(false);
  const manualLocked = item.locked === true;
  const hasTimedLock = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date();
  const steamLocked = !manualLocked && (!item.tradable || hasTimedLock);
  const isLocked = manualLocked || steamLocked;
  const isUnavailable = item.belowThreshold && item.priceSource !== "manual";
  const cannotSelect = isLocked || isUnavailable;

  const nameColor = item.rarityColor ?? "#e4e4e7";
  const cardTitle = manualLocked ? lockedManualItemNativeTitle(item, l) : item.name;
  /** Top sticker strip: clear lock / selection check / inspect (right-8). */
  const stickerStripLeftClass =
    isLocked && isSelected ? "left-[3.35rem]" : isLocked ? "left-[2.55rem]" : isSelected ? "left-5" : "left-0.5";

  return (
    <div
      title={cardTitle}
      {...(manualLocked
        ? { role: "button" as const, tabIndex: 0, "aria-label": cardTitle }
        : {})}
      onClick={() => {
        if (manualLocked) {
          onLockedItemClick?.(item);
          return;
        }
        if (!cannotSelect) onToggle();
      }}
      onKeyDown={
        manualLocked
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onLockedItemClick?.(item);
              }
            }
          : undefined
      }
      className={`group relative flex aspect-square w-full min-w-0 flex-col overflow-visible rounded-lg border transition-[border-color,box-shadow,background-color] duration-150 ${
        manualLocked
          ? "cursor-not-allowed border-zinc-700/45 bg-zinc-900/80 opacity-[0.62] contrast-[0.92] [filter:grayscale(32%)] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50"
          : cannotSelect
            ? "border-zinc-800/40 bg-zinc-900/40 opacity-50"
            : isSelected
              ? "border-amber-500/60 bg-zinc-800/80 shadow-[0_0_0_1px_rgba(245,158,11,0.35)] cursor-pointer"
              : "border-zinc-800/40 bg-zinc-900/60 hover:border-zinc-600/55 hover:bg-zinc-800/55 hover:shadow-md cursor-pointer"
      }`}
    >
      {isSelected && (
        <div className="absolute left-1 top-1 z-[46] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[7px] font-bold text-black shadow-sm">
          ✓
        </div>
      )}

      {/* Image ~70% — main visual */}
      <div className="relative flex min-h-0 flex-[7] items-center justify-center overflow-visible p-1">
        {isUnavailable ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.iconUrl}
              alt=""
              className="max-h-[92%] max-w-[92%] object-contain blur-sm opacity-40"
              loading="lazy"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-px px-1 text-center">
              <span className="text-sm text-zinc-500">ⓘ</span>
              <span className="text-[8px] font-semibold uppercase leading-tight text-amber-600">UNAVAILABLE</span>
              <span className="text-[7px] leading-tight text-zinc-500">(Unstable)</span>
            </div>
          </>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={item.iconUrl}
            alt={item.name}
            className={`max-h-[92%] max-w-[92%] object-contain ${manualLocked ? "" : "transition-transform duration-200 ease-out group-hover:scale-[1.02]"}`}
            loading="lazy"
          />
        )}

        {/* Stickers: top strip beside inspect (do not cover weapon). */}
        {item.stickers.length > 0 ? (
          <div
            className={`group/stickers pointer-events-auto absolute top-0.5 z-[44] min-w-0 pr-0.5 ${stickerStripLeftClass} right-8`}
          >
            <div
              className="flex max-w-full flex-nowrap items-center justify-start gap-0.5 overflow-hidden rounded-md bg-zinc-950/90 px-0.5 py-0.5 shadow-md ring-1 ring-black/45"
              aria-label={item.stickers.map((s, i) => stickerLabel(s, i, l)).join(", ")}
            >
              {item.stickers.slice(0, 5).map((s, i) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={i}
                  src={s.iconUrl}
                  alt=""
                  className="size-[18px] shrink-0 rounded border border-zinc-600/60 bg-zinc-900 object-contain shadow-sm"
                  loading="lazy"
                />
              ))}
              {item.stickers.length > 5 && (
                <span className="shrink-0 self-center pl-px text-[7px] font-medium leading-none text-zinc-400">
                  +{item.stickers.length - 5}
                </span>
              )}
            </div>
            <div className="pointer-events-none invisible absolute left-0 top-full z-[60] mt-1 w-max max-w-[min(240px,calc(100vw-32px))] rounded-md border border-zinc-600/90 bg-zinc-950 px-2 py-1.5 text-left text-[8px] leading-snug text-zinc-100 shadow-xl opacity-0 transition-opacity duration-150 group-hover/stickers:visible group-hover/stickers:opacity-100">
              <p className="mb-1 text-[7px] font-semibold uppercase tracking-wide text-zinc-500">{t("stickers", l)}</p>
              <ul className="list-none space-y-1">
                {item.stickers.map((s, i) => (
                  <li key={`${item.assetId}-st-${i}`} className="break-words border-b border-zinc-800/80 pb-1 last:border-0 last:pb-0">
                    {stickerLabel(s, i, l)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {/* Hover: full name (+ phase if not in name). Wear stays only in footer row — no duplicate Field-Tested / FN line. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[22] rounded-b-md bg-gradient-to-t from-zinc-950/95 via-zinc-950/75 to-transparent opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
          aria-hidden
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[24] max-h-[40%] overflow-hidden px-1.5 pb-1 pt-3 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100">
          <SteamRarityText
            color={nameColor}
            className="break-words text-center text-[8px] font-semibold leading-snug drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] line-clamp-4"
          >
            {item.name}
            {item.phaseLabel && !item.name.toLowerCase().includes(item.phaseLabel.toLowerCase()) ? (
              <span className={`font-bold ${phaseTextColor(item.phaseLabel)}`}> · {item.phaseLabel}</span>
            ) : null}
          </SteamRarityText>
        </div>

        {isLocked && (
          <div className="absolute left-0.5 top-0.5 z-[50] flex max-w-[calc(100%-2.25rem)] items-center gap-0.5 rounded bg-orange-800/95 px-1 py-0.5 text-[7px] font-medium text-orange-50 shadow-md ring-1 ring-orange-950/40 backdrop-blur-[2px]">
            <span className="shrink-0" aria-hidden>
              🔒
            </span>
            {!manualLocked ? (
              <span className="min-w-0 truncate">
                {hasTimedLock ? fmtLockI18n(item.tradeLockUntil!, l) : "Locked"}
              </span>
            ) : item.tradeLockUntil?.trim() ? (
              <span className="min-w-0 truncate" title={formatTradeLockDateDisplay(item.tradeLockUntil, l)}>
                {new Date(item.tradeLockUntil) > new Date()
                  ? fmtLockI18n(item.tradeLockUntil, l)
                  : formatTradeLockDateDisplay(item.tradeLockUntil, l)}
              </span>
            ) : null}
          </div>
        )}

        {item.inspectLink ? <InspectInGameButton href={item.inspectLink} lang={l} /> : null}
      </div>

      {/* Footer ~30% — name+phase (hover hides) → float track → price */}
      <div className="relative flex min-h-0 flex-[3] flex-col justify-end gap-1 px-1.5 pb-1 pt-0.5">
        {manualLocked ? (
          <p
            className="line-clamp-1 w-full text-center text-[7px] leading-tight text-orange-200/90 transition-opacity duration-200 group-hover:opacity-0"
            title={lockedManualCardSubtitle(item, l)}
          >
            {lockedManualCardSubtitle(item, l)}
          </p>
        ) : null}
        {showAssetId ? (
          <div
            className="flex w-full max-w-full items-center gap-0.5 transition-opacity duration-200 group-hover:opacity-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span className="min-w-0 flex-1 truncate text-center font-mono text-[7px] leading-tight text-amber-600/90" title={item.assetId}>
              {item.assetId}
            </span>
            <button
              type="button"
              className="shrink-0 rounded border border-amber-800/40 bg-zinc-900/90 px-0.5 py-px text-[7px] font-medium text-amber-500/90 hover:bg-zinc-800"
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
              {assetCopied ? "✓" : t("copy", l)}
            </button>
          </div>
        ) : null}

        {/* Bottom-align name in fixed band so short titles sit on the “red” line (just above float), 2–3 lines grow upward (green/blue). */}
        <div className="flex min-h-[40px] w-full flex-col justify-end transition-opacity duration-200 ease-out opacity-100 group-hover:opacity-0">
          <SteamRarityText
            color={nameColor}
            className="line-clamp-3 w-full text-center text-[8px] font-semibold leading-snug"
          >
            {item.name}
            {item.phaseLabel && !item.name.toLowerCase().includes(item.phaseLabel.toLowerCase()) ? (
              <span className={`font-bold ${phaseTextColor(item.phaseLabel)}`}> · {item.phaseLabel}</span>
            ) : null}
          </SteamRarityText>
        </div>

        {item.floatValue != null ? (
          <div className="flex min-h-[22px] flex-col justify-end gap-0.5">
            <div className="flex w-full items-baseline justify-between gap-1 text-[8px] leading-none">
              <span className="shrink-0 font-mono font-medium tabular-nums text-zinc-200">
                {item.floatValue.toFixed(item.floatValue < 0.01 ? 6 : 4)}
              </span>
              {item.wear ? (
                <span className="min-w-0 max-w-[58%] truncate text-right text-[7px] font-medium text-zinc-400" title={item.wear}>
                  {item.wear}
                </span>
              ) : null}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-700/80 ring-1 ring-zinc-900/80">
              <FloatBarFillInner floatValue={item.floatValue} />
            </div>
          </div>
        ) : (
          <div className="min-h-[22px] shrink-0" aria-hidden />
        )}

        <div className="flex min-h-[18px] items-end justify-between gap-1 border-t border-zinc-800/40 pt-0.5">
          {item.priceSource === "unavailable" || isUnavailable ? (
            <span className="text-[10px] text-zinc-600">—</span>
          ) : (
            <span className="truncate text-xs font-bold tabular-nums leading-none tracking-tight text-amber-400 sm:text-[13px]">
              {fmtFn(item.priceUsd)}
            </span>
          )}
          {item.priceSource === "manual" && showAssetId ? (
            <span className="shrink-0 text-[7px] text-amber-700">man.</span>
          ) : null}
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

function TradeManualChecklistItemRow({
  item,
  fmt: fmtFn,
  lang: l,
}: {
  item: InventoryItem;
  fmt: (cents: number) => string;
  lang: LangCode;
}) {
  const phaseInName =
    item.phaseLabel && item.name.toLowerCase().includes(item.phaseLabel.toLowerCase());
  return (
    <div className="flex gap-2 rounded-lg border border-zinc-800/70 bg-[#0d0d0f] p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.iconUrl} alt="" className="h-11 w-11 shrink-0 object-contain" loading="lazy" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-left text-[10px] font-semibold leading-snug text-zinc-100">{item.name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-zinc-500">
          {item.wear ? <span className="text-zinc-400">{item.wear}</span> : null}
          {item.floatValue != null ? (
            <span className="font-mono tabular-nums text-zinc-300">
              {item.floatValue.toFixed(item.floatValue < 0.01 ? 6 : 4)}
            </span>
          ) : null}
          {item.phaseLabel && !phaseInName ? (
            <span className={`font-medium ${phaseTextColor(item.phaseLabel)}`}>
              {t("tradeSubmitPattern", l)}: {item.phaseLabel}
            </span>
          ) : null}
          {item.stickers.length > 0 ? (
            <span className="text-zinc-600">
              {t("stickers", l)}: {item.stickers.length}
            </span>
          ) : null}
        </div>
        {item.floatValue != null ? (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-700/80 ring-1 ring-zinc-950/80">
            <FloatBarFillInner floatValue={item.floatValue} />
          </div>
        ) : null}
        <p className="mt-1 text-[11px] font-bold tabular-nums text-amber-400">{fmtFn(item.priceUsd)}</p>
      </div>
    </div>
  );
}

