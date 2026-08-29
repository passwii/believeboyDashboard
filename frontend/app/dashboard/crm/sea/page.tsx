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
    // BLF-837：页面标题已由 Top Header 面包屑承载（BLF-824 去重原则）
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        <Button
          size="sm"
          variant="outline"
          className="h-9 rounded-none border-term-border bg-term-panel font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="mr-0.5 h-4 w-4" /> 导入客户
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <CrmSeaTable key={refreshKey} />
      </div>
      <CrmImportSea
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
