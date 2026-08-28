'use client'

import { PenLine, Zap } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'

export default function ReconcilePage() {
  return (
    <div className="w-full space-y-6">
      <Tabs defaultValue="auto" className="w-full">
        {/* BLF-883 全局统一：variant="term" + 前置 icon（与外层月报 Tab 同规格） */}
        <TabsList variant="term" className="mb-6 w-fit justify-start">
          <TabsTrigger value="auto" variant="term">
            <Zap aria-hidden />
            自动核对
          </TabsTrigger>
          <TabsTrigger value="manual" variant="term">
            <PenLine aria-hidden />
            手动核对
          </TabsTrigger>
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
