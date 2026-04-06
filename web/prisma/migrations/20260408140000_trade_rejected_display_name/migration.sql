-- AlterEnum
ALTER TYPE "TradeStatus" ADD VALUE 'rejected';

-- AlterTable
ALTER TABLE "TradeItem" ADD COLUMN "displayName" TEXT;
