import Link from "next/link";
import { notFound } from "next/navigation";

import { TradeAdminForm } from "@/app/admin/trades/trade-admin-form";
import { prisma } from "@/lib/prisma";
import { serializeTradeFull } from "@/lib/trade-api-serialize";

export const dynamic = "force-dynamic";

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

type Props = { params: Promise<{ tradeId: string }> };

export default async function AdminTradeDetailPage({ params }: Props) {
  const { tradeId } = await params;

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { items: true, creator: true },
  });

  if (!trade) notFound();

  const full = serializeTradeFull(trade);
  const guestItems = full.items.filter((i) => i.side === "guest");
  const ownerItems = full.items.filter((i) => i.side === "owner");

  return (
    <main className="mx-auto max-w-4xl space-y-8">
      <div>
        <Link href="/admin/trades" className="text-sm text-amber-700 hover:underline dark:text-amber-400">
          ← К списку заявок
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">Заявка</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">{trade.id}</p>
      </div>

      <div className="grid gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 sm:grid-cols-2">
        <div>
          <h2 className="text-xs font-medium uppercase text-zinc-500">Пользователь</h2>
          <p className="mt-1 text-zinc-900 dark:text-zinc-100">{trade.creator.displayName ?? "—"}</p>
          <p className="font-mono text-sm text-zinc-600 dark:text-zinc-400">{trade.creator.steamId}</p>
          <a
            href={`https://steamcommunity.com/profiles/${trade.creator.steamId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-amber-700 hover:underline dark:text-amber-400"
          >
            Профиль Steam →
          </a>
        </div>
        <div>
          <h2 className="text-xs font-medium uppercase text-zinc-500">Сводка</h2>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            Статус: <strong>{statusLabel(trade.status)}</strong>
          </p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Создана: {trade.createdAt.toLocaleString("ru-RU")}
          </p>
          <p className="mt-2 text-sm">
            Гость отдаёт: <span className="font-semibold tabular-nums">{fmtUsd(full.guestTotalCents)}</span>
          </p>
          <p className="text-sm">
            Магазин отдаёт: <span className="font-semibold tabular-nums">{fmtUsd(full.ownerTotalCents)}</span>
          </p>
        </div>
      </div>

      {trade.notes ? (
        <div className="rounded-xl border border-zinc-200 bg-amber-50/50 p-4 text-sm dark:border-zinc-800 dark:bg-amber-950/20">
          <span className="text-xs font-medium uppercase text-zinc-500">Текущая заметка</span>
          <p className="mt-2 whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{trade.notes}</p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Отдаёт пользователь</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {guestItems.map((it) => (
              <li key={it.id} className="border-b border-zinc-100 pb-2 dark:border-zinc-800">
                <p className="font-medium text-zinc-800 dark:text-zinc-200">{it.displayName ?? it.marketHashName}</p>
                <p className="text-xs text-zinc-500">
                  {fmtUsd(it.priceUsdCents)}
                  {it.wear ? ` · ${it.wear}` : ""}
                  {it.floatValue != null ? ` · float ${it.floatValue.toFixed(4)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Отдаёт магазин</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {ownerItems.map((it) => (
              <li key={it.id} className="border-b border-zinc-100 pb-2 dark:border-zinc-800">
                <p className="font-medium text-zinc-800 dark:text-zinc-200">{it.displayName ?? it.marketHashName}</p>
                <p className="text-xs text-zinc-500">
                  {fmtUsd(it.priceUsdCents)}
                  {it.wear ? ` · ${it.wear}` : ""}
                  {it.floatValue != null ? ` · float ${it.floatValue.toFixed(4)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <TradeAdminForm tradeId={trade.id} initialStatus={trade.status} initialNotes={trade.notes} />
    </main>
  );
}
