-- CreateTable
CREATE TABLE "FxRatesSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "rates" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FxRatesSnapshot_pkey" PRIMARY KEY ("id")
);
