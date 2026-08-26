'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ManualCalculationPanel from './components/manual-calculation-panel'
import MonthlySkuAnalysisPanel from './components/monthly-sku-analysis-panel'
import ProductAnalysisPanel from './components/product-analysis-panel'

// BLF-836 终端化：页面标题由 TerminalHeader 面包屑承载（PageHeader 胶囊移除），
// Tab 条换终端规格（h-8 / 零圆角 / 1px 边界 / 激活态 term-raised）。
const TERM_TRIGGER_CLASS =
  'h-8 rounded-none px-3 text-xs text-term-muted data-[state=active]:bg-term-raised data-[state=active]:text-term-text'

export default function ProductAnalysisPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<'product-analysis' | 'manual' | 'monthly-sku'>(
    'product-analysis'
  )

  return (
    <div className="space-y-3">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
        className="space-y-3"
      >
        <TabsList className="h-8 w-fit justify-start gap-0 rounded-none border border-term-border bg-term-panel p-0">
          <TabsTrigger value="product-analysis" className={TERM_TRIGGER_CLASS}>
            产品分析核算
          </TabsTrigger>
          <TabsTrigger value="manual" className={TERM_TRIGGER_CLASS}>
            手动核算
          </TabsTrigger>
          <TabsTrigger value="monthly-sku" className={TERM_TRIGGER_CLASS}>
            月度 SKU 分析
          </TabsTrigger>
        </TabsList>

        <TabsContent value="product-analysis" className="space-y-0">
          <ProductAnalysisPanel session={session} />
        </TabsContent>

        <TabsContent value="manual" className="space-y-0">
          <ManualCalculationPanel />
        </TabsContent>

        <TabsContent value="monthly-sku" className="space-y-0">
          <MonthlySkuAnalysisPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
