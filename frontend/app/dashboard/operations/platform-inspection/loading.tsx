import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'

export default function PlatformInspectionLoading() {
  return <WarmRouteLoading variant="table" columns={7} rows={6} label="正在加载平台巡检" />
}
