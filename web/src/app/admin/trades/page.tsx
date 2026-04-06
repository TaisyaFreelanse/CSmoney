import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { serializeTradeSummary } from "@/lib/trade-api-serialize";
import type { TradeStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

function statusFilterWhere(status: string | undefined): { status: TradeStatus } | Record<string, never> {
  if (!status || status === "all") return {};
  if (status === "accepted") return { status: "accepted_by_admin" };
  const allowed: TradeStatus[] = [
    "pending",
    "accepted_by_admin",
    "rejected",
    "completed",
    "cancelled",
  ];
  if (allowed.includes(status as TradeStatus)) return { status: status as TradeStatus };
  return {};
}

function statusLabel(s: string): string {
  const m: Record<string, string> = {
    pending: "Ожидает",
    accepted_by_admin: "Принято",
    rejected: "Отклонено",
    completed: "Завершено",
    cancelled: "Отменено",
  };
  return m[s] ?? s;
}

function fmtUsd(cents: number): string {
  return `${(cents / 100).toFixed(2)} USD`;
}

const TABS: { key: string; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "pending", label: "Ожидают" },
  { key: "accepted", label: "Принято" },
  { key: "rejected", label: "Отклонено" },
  { key: "completed", label: "Завершено" },
];

type Props = { searchParams: Promise<{ status?: string }> };

export default async function AdminTradesPage({ searchParams }: Props) {
  const sp = await searchParams;
  const filter = sp.status ?? "all";
  const where = statusFilterWhere(filter === "all" ? undefined : filter);

  const rows = await prisma.trade.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 300,
    include: {
      items: true,
      creator: { select: { steamId: true, displayName: true } },
    },
  });

  return (
    <main className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Заявки на обмен</h1>
        <p className="text-sm text-zinc-500">Всего в выборке: {rows.length}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const href = t.key === "all" ? "/admin/trades" : `/admin/trades?status=${t.key}`;
          const active = filter === t.key;
          return (
            <Link
              key={t.key}
              href={href}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                active
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Пользователь</th>
              <th className="px-4 py-3">Статус</th>
              <th className="px-4 py-3">Дата</th>
              <th className="px-4 py-3 text-right">Отдаёт (гость)</th>
              <th className="px-4 py-3 text-right">Получает (магазин)</th>
              <th className="px-4 py-3 text-right">Предм.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tr) => {
              const sum = serializeTradeSummary(tr);
              return (
                <tr key={tr.id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/trades/${tr.id}`}
                      className="font-mono text-xs text-amber-700 hover:underline dark:text-amber-400"
                      title={tr.id}
                    >
                      {tr.id.slice(0, 10)}…
                    </Link>
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-2 text-zinc-800 dark:text-zinc-200">
                    {tr.creator.displayName ?? "—"}
                    <span className="block font-mono text-[11px] text-zinc-500">{tr.creator.steamId}</span>
                  </td>
                  <td className="px-4 py-2">{statusLabel(tr.status)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {tr.createdAt.toLocaleString("ru-RU")}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtUsd(sum.guestTotalCents)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtUsd(sum.ownerTotalCents)}</td>
                  <td className="px-4 py-2 text-right text-zinc-500">{sum.itemCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">Нет заявок в этом фильтре.</p>
        ) : null}
      </div>
    </main>
  );
}
