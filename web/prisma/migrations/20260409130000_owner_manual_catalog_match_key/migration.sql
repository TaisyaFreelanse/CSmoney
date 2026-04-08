-- Denormalized key so manual prices apply to guest items (different Steam assetId, same skin).
ALTER TABLE "OwnerManualPrice" ADD COLUMN "catalogMatchKey" TEXT;
CREATE INDEX "OwnerManualPrice_catalogMatchKey_idx" ON "OwnerManualPrice"("catalogMatchKey");
