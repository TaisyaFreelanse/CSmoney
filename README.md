

## Приложение

Код сайта — в каталоге **`web/`** (Next.js + Prisma + PostgreSQL).

### Быстрый старт (разработка)

1. Установите зависимости:

   ```bash
   cd web
   npm install
   ```

2. Создайте `web/.env` на основе `web/.env.example` и укажите `DATABASE_URL`.

   Локально можно поднять Postgres:

   ```bash
   cd ..
   docker compose up -d
   ```

   Пример строки:

   ```env
   DATABASE_URL="postgresql://csmoney:csmoney@localhost:5432/csmoney"
   ```

3. Примените схему к базе (первый раз):

   ```bash
   cd web
   npx prisma migrate dev --name init
   ```

   Либо без файлов миграций (только для пробы):

   ```bash
   npx prisma db push
   ```

4. Запуск:

   ```bash
   npm run dev
   ```

Откройте [http://localhost:3000](http://localhost:3000). Проверка БД: [http://localhost:3000/api/health](http://localhost:3000/api/health).

### Деплой

На хостинге (Vercel, Render и т.д.) задайте переменную `DATABASE_URL`, выполните миграции (`prisma migrate deploy`) в шаге сборки или отдельной командой — по инструкции выбранной платформы.
