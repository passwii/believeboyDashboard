'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import { CrmSeaTable } from '@/components/crm/sea-table'
import { CrmImportSea } from '@/components/crm'
import { Button } from '@/components/ui/button'

export default function SeaPage() {
  const [importOpen, setImportOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* 总则 5：标题行手机端 flex-wrap，避免标题+按钮同行挤压 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">客户公海</h1>
          <p className="text-sm text-muted-foreground">无人认领的客户，可一键领取或批量导入</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="mr-1 h-4 w-4" /> 导入客户
        </Button>
      </div>
      <CrmSeaTable key={refreshKey} />
      <CrmImportSea
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
