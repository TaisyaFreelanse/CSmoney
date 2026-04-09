"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { t, tradeStatusLabel, type LangCode } from "@/lib/i18n";

type TradeSummary = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  guestTotalCents: number;
  ownerTotalCents: number;
  itemCount: number;
};

function fmtUsdCents(cents: number): string {
  return `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

/** Up to `max` consecutive page numbers around `current`. */
function visiblePages(current: number, total: number, max: number): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i + 1);
  const half = Math.floor(max / 2);
  let start = Math.max(1, current - half);
  const end = Math.min(total, start + max - 1);
  start = Math.max(1, end - max + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export default function TradesListClient() {
  const [lang, setLang] = useState<LangCode>("ru");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [trades, setTrades] = useState<TradeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("chez_lang") as LangCode | null;
    if (stored === "ru" || stored === "en" || stored === "zh") {
      // Post-mount sync avoids SSR/localStorage hydration mismatch.
      queueMicrotask(() => setLang(stored));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      const res = await fetch(`/api/trades?page=${page}`, { credentials: "include" });
      if (cancelled) return;
      if (res.status === 401) {
        setUnauthorized(true);
        setTrades([]);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? data?.error ?? t("tradesLoadError", lang));
        setTrades([]);
        return;
      }
      setUnauthorized(false);
      setTrades(Array.isArray(data?.trades) ? data.trades : []);
      const tp = typeof data?.totalPages === "number" ? Math.max(1, data.totalPages) : 1;
      setTotalPages(tp);
      const resolvedPage = typeof data?.page === "number" ? data.page : page;
      if (resolvedPage !== page) setPage(resolvedPage);
    })();
    return () => {
      cancelled = true;
    };
  }, [lang, page]);

  const skipScrollOnMount = useRef(true);
  useEffect(() => {
    if (skipScrollOnMount.current) {
      skipScrollOnMount.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [page]);

  const desktopPages = useMemo(() => visiblePages(page, totalPages, 5), [page, totalPages]);

  const goPage = useCallback((p: number) => {
    setPage((prev) => {
      const next = Math.max(1, Math.min(totalPages, p));
      return next === prev ? prev : next;
    });
  }, [totalPages]);

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-zinc-100">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 bg-[#111113] px-4 py-2 sm:px-5">
        <Link href="/" className="text-sm font-bold tracking-tight text-amber-500">
          CHEZ<span className="text-zinc-300">TRADING</span>
        </Link>
        <Link href="/" className="text-xs text-zinc-500 hover:text-amber-400/90">
          {t("tradesBackToTrade", lang)}
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-3 py-4 sm:px-4 sm:py-6">
        <h1 className="mb-4 text-lg font-semibold text-zinc-100 sm:text-xl">{t("tradesPageTitle", lang)}</h1>

        {unauthorized ? (
          <p className="text-sm text-zinc-500">
            {t("tradesLoginPrompt", lang)}{" "}
            <a href="/api/auth/steam" className="text-amber-500 hover:underline">
              Steam
            </a>
          </p>
        ) : null}

        {error ? <p className="text-sm text-red-400">{error}</p> : null}

        {trades === null && !unauthorized && !error ? (
          <p className="text-sm text-zinc-500">{t("tradesLoading", lang)}</p>
        ) : null}

        {trades && trades.length === 0 && !unauthorized && !error ? (
          <p className="text-sm text-zinc-500">{t("tradesEmpty", lang)}</p>
        ) : null}

        {trades && trades.length > 0 ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
              <table className="w-full min-w-[520px] border-collapse text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-zinc-800/60 bg-zinc-900/50 text-[10px] uppercase tracking-wide text-zinc-500 sm:text-[11px]">
                    <th className="px-2 py-2 sm:px-3">{t("tradesId", lang)}</th>
                    <th className="px-2 py-2 sm:px-3">{t("tradesDate", lang)}</th>
                    <th className="px-2 py-2 sm:px-3">{t("tradesStatus", lang)}</th>
                    <th className="px-2 py-2 text-right sm:px-3">{t("tradesGuestTotal", lang)}</th>
                    <th className="px-2 py-2 text-right sm:px-3">{t("tradesOwnerTotal", lang)}</th>
                    <th className="px-2 py-2 text-right sm:px-3">{t("tradesItemCount", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((tr) => (
                    <tr key={tr.id} className="border-b border-zinc-800/40 hover:bg-zinc-900/30">
                      <td className="px-2 py-2 sm:px-3">
                        <Link
                          href={`/trades/${tr.id}`}
                          className="font-mono text-[11px] text-amber-500/90 hover:underline sm:text-xs"
                          title={tr.id}
                        >
                          {tr.id.slice(0, 10)}…
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-zinc-400 sm:px-3">
                        {new Date(tr.createdAt).toLocaleString(lang === "ru" ? "ru-RU" : lang === "zh" ? "zh-CN" : "en-GB", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-2 py-2 sm:px-3">{tradeStatusLabel(tr.status, lang)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-200 sm:px-3">{fmtUsdCents(tr.guestTotalCents)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-200 sm:px-3">{fmtUsdCents(tr.ownerTotalCents)}</td>
                      <td className="px-2 py-2 text-right text-zinc-400 sm:px-3">{tr.itemCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => goPage(page - 1)}
                  className="rounded-md border border-zinc-700/80 bg-zinc-900/40 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-amber-600/40 hover:text-amber-400/90 disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-xs"
                >
                  {t("tradesPaginationPrev", lang)}
                </button>

                <span className="tabular-nums text-[11px] text-zinc-500 sm:hidden">
                  {page} / {totalPages}
                </span>

                <div className="hidden items-center gap-1 sm:flex">
                  {desktopPages.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => goPage(p)}
                      className={
                        p === page
                          ? "min-w-[2rem] rounded-md bg-amber-500/20 px-2 py-1 text-center text-xs font-semibold text-amber-400 ring-1 ring-amber-500/35"
                          : "min-w-[2rem] rounded-md border border-zinc-700/70 px-2 py-1 text-center text-xs font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                      }
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => goPage(page + 1)}
                  className="rounded-md border border-zinc-700/80 bg-zinc-900/40 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-amber-600/40 hover:text-amber-400/90 disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-xs"
                >
                  {t("tradesPaginationNext", lang)}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
