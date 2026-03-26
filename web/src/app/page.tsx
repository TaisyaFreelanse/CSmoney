export default function Home() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <main className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          CS2 trade — MVP
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Каркас проекта: Next.js, Prisma, PostgreSQL. Дальше — вход через Steam, инвентари и
          заявки.
        </p>
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-500">
          Проверка API:{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
            GET /api/health
          </code>{" "}
          (при рабочей{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">DATABASE_URL</code>{" "}
          вернётся{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
            database: &quot;up&quot;
          </code>
          ).
        </p>
      </main>
    </div>
  );
}
