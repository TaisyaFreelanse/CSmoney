import TradeDetailClient from "./trade-detail-client";

export default async function TradeDetailPage({ params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return <TradeDetailClient tradeId={tradeId} />;
}
