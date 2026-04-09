-- CreateTable
CREATE TABLE "telegram_notify_dedupe" (
    "dedupeKey" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_notify_dedupe_pkey" PRIMARY KEY ("dedupeKey")
);
