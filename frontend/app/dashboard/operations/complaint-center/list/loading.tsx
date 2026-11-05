import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'

export default function ComplaintListLoading() {
  return <WarmRouteLoading variant="table" columns={7} rows={6} label="正在加载客诉明细" />
}
