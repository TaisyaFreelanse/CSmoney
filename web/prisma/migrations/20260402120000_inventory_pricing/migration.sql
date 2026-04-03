-- Add tradeUrl to User
ALTER TABLE "User" ADD COLUMN "tradeUrl" TEXT;

-- Add phaseLabel and floatValue to TradeItem
ALTER TABLE "TradeItem" ADD COLUMN "phaseLabel" TEXT;
ALTER TABLE "TradeItem" ADD COLUMN "floatValue" DOUBLE PRECISION;

-- PriceCatalogItem
CREATE TABLE "PriceCatalogItem" (
    "id" TEXT NOT NULL,
    "marketHashName" TEXT NOT NULL,
    "phaseKey" TEXT NOT NULL DEFAULT 'default',
    "providerKey" TEXT NOT NULL DEFAULT 'buff163',
    "priceUsd" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceCatalogItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PriceCatalogItem_marketHashName_phaseKey_providerKey_key" ON "PriceCatalogItem"("marketHashName", "phaseKey", "providerKey");
CREATE INDEX "PriceCatalogItem_marketHashName_idx" ON "PriceCatalogItem"("marketHashName");

-- PricingSettings (singleton)
CREATE TABLE "PricingSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "selectedPriceProvider" TEXT NOT NULL DEFAULT 'buff163',
    "markupGuestPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "markupOwnerPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minPriceThresholdUsd" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PricingSettings_pkey" PRIMARY KEY ("id")
);

-- OwnerManualPrice
CREATE TABLE "OwnerManualPrice" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "priceUsd" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnerManualPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerManualPrice_assetId_key" ON "OwnerManualPrice"("assetId");
