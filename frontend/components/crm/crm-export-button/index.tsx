'use client'

import { useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import { downloadCrmCsv, type CrmExportEntity } from '@/lib/crm/method/download-csv'

export interface CrmExportButtonProps {
  /** 导出实体：customers（客户）/ leads（线索） */
  entity: CrmExportEntity
  /** 当前数据范围（mine/all/sea） */
  scope?: 'mine' | 'all' | 'sea'
  /** 当前关键词过滤 */
  keyword?: string
}

/**
 * 「导出 CSV」按钮：按当前 scope/keyword 下载客户/线索清单。
 * 成功/失败走全局通知。
 */
export function CrmExportButton({ entity, scope, keyword }: CrmExportButtonProps) {
  const { notify } = useNotifications()
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      await downloadCrmCsv(entity, { scope, keyword: keyword || undefined })
      notify({ type: 'success', title: '导出成功', message: 'CSV 已开始下载' })
    } catch (e) {
      notify({ type: 'error', title: '导出失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting} data-testid="crm-export-csv">
      <Download className="mr-1 h-4 w-4" />
      {exporting ? '导出中…' : '导出 CSV'}
    </Button>
  )
}
