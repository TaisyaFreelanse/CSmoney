# ChezTrading 

Платформа для обмена скинами **CS2**: витрина магазина (CHEZ), инвентарь пользователя после входа через **Steam**, оформление трейда и связанные API.

## Стек

- **Next.js** (App Router)
- **React**
- **Prisma** + **PostgreSQL**
- **Tailwind CSS** v4
- **Redis** (опционально, кэш инвентаря)

## Установка и запуск

Рабочая директория приложения — `**web/`**.

```bash
cd web
npm install
```

Создайте `**web/.env**` по образцу `**web/.env.example**` (минимум `DATABASE_URL`, см. ниже).

Первый раз — миграции:

```bash
npx prisma migrate dev
```

Запуск в режиме разработки:

```bash
npm run dev
```

Сайт: [http://localhost:3000](http://localhost:3000). Проверка БД: [http://localhost:3000/api/health](http://localhost:3000/api/health).

Локально Postgres можно поднять из корня репозитория: `docker compose up -d` (см. `docker-compose` в репо).

## Структура проекта

```text
web/
  src/
    app/           — маршруты Next.js, layout, API routes (app/api/…)
    app/globals.css — глобальные стили + Tailwind
    components/    — переиспользуемые UI (если вынесены из app)
    lib/             — утилиты, i18n, Prisma, бизнес-логика
  prisma/          — schema и миграции
  public/          — статика
  scripts/         — render-start, render-release и др.
```

Крупный UI трейда частично живёт в `**app/trade/**` (страница + CSS-модуль) и в `**trade-client.tsx**`.

## Где что менять


| Что                                           | Где                                  |
| --------------------------------------------- | ------------------------------------ |
| UI страницы трейда                            | `web/src/app/trade/`                 |
| Основная логика/сетка трейда, фильтры маркета | `web/src/app/trade/trade-client.tsx` |
| Общие компоненты                              | `web/src/components/`                |
| API                                           | `web/src/app/api/`                   |
| Переводы                                      | `web/src/lib/i18n.ts`                |


## Переменные окружения

Значения не коммитить. Полный список и комментарии — в `**web/.env.example**`.

Основные:

- `DATABASE_URL`
- `SESSION_SECRET`
- `NEXT_PUBLIC_APP_URL`
- `STEAM_WEB_API_KEY`
- `OWNER_STEAM_ID` (инвентарь витрины)
- `REDIS_URL` (опционально)
- `ADMIN_STEAM_IDS`, `CRON_SECRET`, `PRICEMPIRE_API_KEY`, `EXCHANGE_RATE_API_KEY` — по необходимости

## Деплой (Render)

- **Build:** `npm run build` (в каталоге `web/`: `prisma generate` + `next build`)
- **Start:** `npm start` → `scripts/render-start.mjs`
- **Миграции в проде:** отдельной командой релиза — `**npm run render:release`** (`prisma migrate deploy`), не блокируя долгий старт веб-сервиса

## Важно

- Логику трейда и баланса не менять без понимания последствий.
- Фильтры цены / float / «Others» на странице трейда применяются **только к маркету (CHEZ)**, не к инвентарю пользователя.
- Prisma на проде: предпочтительно `**npm run render:release`** (или эквивалент с `prisma migrate deploy`).

