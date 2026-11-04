'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import { CrmSeaTable } from '@/components/crm/sea-table'
import { CrmImportSea } from '@/components/crm'
import {
  WarmCrmPage,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

export default function SeaPage() {
  const [importOpen, setImportOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载（BLF-824 去重原则）
    <WarmCrmPage>
      <WarmCrmToolbar
        ariaLabel="客户公海工具栏"
        end={
          <WarmButton onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden="true" /> 导入客户
          </WarmButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <CrmSeaTable key={refreshKey} />
      </div>
      <CrmImportSea
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    </WarmCrmPage>
  )
}
