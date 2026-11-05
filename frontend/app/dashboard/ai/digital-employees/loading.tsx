import { WarmRouteLoading } from '@/components/dashboard-v2/warm-ledger/loading/warm-route-loading'

export default function DigitalEmployeesLoading() {
  return <WarmRouteLoading variant="table" columns={6} rows={5} label="正在加载数字员工" />
}
