'use client'

import { FileCheck2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'

export default function ReportReconciliationPage() {
  return (
    <div className="w-full space-y-6">
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-6 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <PageHeader
          className="relative z-10"
          eyebrow={
            <>
              <FileCheck2 className="h-3.5 w-3.5" />
              报表 · 对账核对
            </>
          }
          title="对账核对"
          description="自动/手动核对平台报表与内部账单：上传文件、比对金额差异、下载核对结果。"
        />
      </section>

      <Tabs defaultValue="auto" className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="auto">自动核对</TabsTrigger>
          <TabsTrigger value="manual">手动核对</TabsTrigger>
        </TabsList>

        <TabsContent value="auto">
          <AutoReconcileTab />
        </TabsContent>

        <TabsContent value="manual">
          <ManualReconcileTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
