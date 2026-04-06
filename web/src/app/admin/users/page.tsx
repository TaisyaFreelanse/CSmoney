import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import { UserBanToggle } from "./user-ban-toggle";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const admin = await getSessionUser();
  if (!admin?.isAdmin) {
    redirect("/");
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      steamId: true,
      displayName: true,
      createdAt: true,
      lastLoginAt: true,
      isBanned: true,
      isAdmin: true,
    },
  });

  return (
    <main className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Пользователи</h1>
      <p className="text-sm text-zinc-500">Показано до 500, новые сверху.</p>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[800px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
              <th className="px-4 py-3">Имя Steam</th>
              <th className="px-4 py-3">Steam ID</th>
              <th className="px-4 py-3">Регистрация</th>
              <th className="px-4 py-3">Последний вход</th>
              <th className="px-4 py-3">Статус</th>
              <th className="px-4 py-3 text-right">Действие</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.steamId} className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <span className="text-zinc-900 dark:text-zinc-100">{u.displayName ?? "—"}</span>
                  {u.isAdmin ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                      админ
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{u.steamId}</td>
                <td className="whitespace-nowrap px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {u.createdAt.toLocaleString("ru-RU")}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {u.lastLoginAt ? u.lastLoginAt.toLocaleString("ru-RU") : "—"}
                </td>
                <td className="px-4 py-2">
                  {u.isBanned ? (
                    <span className="text-red-600 dark:text-red-400">Заблокирован</span>
                  ) : (
                    <span className="text-zinc-500">Активен</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <UserBanToggle
                    steamId={u.steamId}
                    isBanned={u.isBanned}
                    currentAdminSteamId={admin.steamId}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
