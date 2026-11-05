import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'

export default function AiInsightsLoading() {
  return <WarmRouteLoading variant="table" columns={6} label="正在加载 AI 洞察" />
}
