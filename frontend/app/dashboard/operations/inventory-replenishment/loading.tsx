import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'

export default function InventoryReplenishmentLoading() {
  return <WarmRouteLoading variant="table" columns={9} label="正在加载补货分析" />
}
