"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { t, tradeStatusLabel, type LangCode } from "@/lib/i18n";

type TradeItemRow = {
  id: string;
  side: string;
  displayName: string | null;
  marketHashName: string | null;
  phaseLabel: string | null;
  assetId: string | null;
  wear: string | null;
  floatValue: number | null;
  priceUsdCents: number;
};

type TradeDetail = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
  guestTotalCents: number;
  ownerTotalCents: number;
  items: TradeItemRow[];
};

const POLL_MS = 8000;

function fmtUsdCents(cents: number): string {
  return `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

export default function TradeDetailClient({ tradeId }: { tradeId: string }) {
  const [lang, setLang] = useState<LangCode>("ru");
  const [trade, setTrade] = useState<TradeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/trades/${tradeId}`, { credentials: "include" });
    if (res.status === 401) {
      setUnauthorized(true);
      setTrade(null);
      return;
    }
    const data = await res.json().catch(() => null);
    if (res.status === 404) {
      setError(t("tradesNotFound", lang));
      setTrade(null);
      return;
    }
    if (!res.ok) {
      setError(data?.message ?? data?.error ?? t("tradesLoadError", lang));
      setTrade(null);
      return;
    }
    setError(null);
    if (data?.trade) setTrade(data.trade as TradeDetail);
  }, [tradeId, lang]);

  useEffect(() => {
    const stored = localStorage.getItem("chez_lang") as LangCode | null;
    if (stored === "ru" || stored === "en" || stored === "zh") setLang(stored);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const guestItems = trade?.items.filter((i) => i.side === "guest") ?? [];
  const ownerItems = trade?.items.filter((i) => i.side === "owner") ?? [];

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-zinc-100">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 bg-[#111113] px-4 py-2 sm:px-5">
        <Link href="/" className="text-sm font-bold tracking-tight text-amber-500">
          CHEZ<span className="text-zinc-300">TRADING</span>
        </Link>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/trades" className="text-zinc-500 hover:text-amber-400/90">
            {t("tradesPageTitle", lang)}
          </Link>
          <Link href="/" className="text-zinc-500 hover:text-amber-400/90">
            {t("tradesBackToTrade", lang)}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
        {unauthorized ? (
          <p className="text-sm text-zinc-500">
            {t("tradesLoginPrompt", lang)}{" "}
            <a href="/api/auth/steam" className="text-amber-500 hover:underline">
              Steam
            </a>
          </p>
        ) : null}

        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        {trade ? (
          <>
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h1 className="text-lg font-semibold text-zinc-100 sm:text-xl">
                  {t("tradesPageTitle", lang)} <span className="font-mono text-base text-amber-500/90">#{trade.id.slice(0, 12)}…</span>
                </h1>
                <p className="mt-1 text-xs text-zinc-500">
                  {tradeStatusLabel(trade.status, lang)} ·{" "}
                  {new Date(trade.createdAt).toLocaleString(lang === "ru" ? "ru-RU" : lang === "zh" ? "zh-CN" : "en-GB")}
                </p>
              </div>
              <p className="text-[10px] text-zinc-600 sm:text-xs">{t("tradesPolling", lang)}</p>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 text-sm">
              <div>
                <p className="text-[10px] uppercase text-zinc-500">{t("tradesGuestTotal", lang)}</p>
                <p className="font-semibold tabular-nums text-amber-400">{fmtUsdCents(trade.guestTotalCents)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-zinc-500">{t("tradesOwnerTotal", lang)}</p>
                <p className="font-semibold tabular-nums text-zinc-200">{fmtUsdCents(trade.ownerTotalCents)}</p>
              </div>
            </div>

            <section className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("tradesYouGiveSide", lang)}</h2>
              <ul className="space-y-2 rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-2">
                {guestItems.map((it) => (
                  <li key={it.id} className="border-b border-zinc-800/40 pb-2 text-xs last:border-0 last:pb-0 sm:text-sm">
                    <p className="font-medium text-zinc-200">{it.displayName ?? it.marketHashName ?? "—"}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {fmtUsdCents(it.priceUsdCents)}
                      {it.wear ? ` · ${t("tradesWear", lang)}: ${it.wear}` : ""}
                      {it.floatValue != null ? ` · ${t("tradesFloat", lang)}: ${it.floatValue.toFixed(4)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("tradesYouGetSide", lang)}</h2>
              <ul className="space-y-2 rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-2">
                {ownerItems.map((it) => (
                  <li key={it.id} className="border-b border-zinc-800/40 pb-2 text-xs last:border-0 last:pb-0 sm:text-sm">
                    <p className="font-medium text-zinc-200">{it.displayName ?? it.marketHashName ?? "—"}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {fmtUsdCents(it.priceUsdCents)}
                      {it.wear ? ` · ${t("tradesWear", lang)}: ${it.wear}` : ""}
                      {it.floatValue != null ? ` · ${t("tradesFloat", lang)}: ${it.floatValue.toFixed(4)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
