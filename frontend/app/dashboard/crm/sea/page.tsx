import { CrmSeaTable } from '@/components/crm/sea-table'

export default function SeaPage() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">客户公海</h1>
        <p className="text-sm text-muted-foreground">无人认领的客户，可一键领取（MVP 手动模式，无自动回收）</p>
      </div>
      <CrmSeaTable />
    </div>
  )
}
