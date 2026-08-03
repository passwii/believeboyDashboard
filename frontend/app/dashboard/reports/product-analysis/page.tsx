'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ManualCalculationPanel from './components/manual-calculation-panel'
import MonthlySkuAnalysisPanel from './components/monthly-sku-analysis-panel'
import ProductAnalysisPanel from './components/product-analysis-panel'

export default function ProductAnalysisPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<'product-analysis' | 'manual' | 'monthly-sku'>(
    'product-analysis'
  )

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as typeof activeTab)}
      className="space-y-4"
    >
      <TabsList>
        <TabsTrigger value="product-analysis">产品分析核算</TabsTrigger>
        <TabsTrigger value="manual">手动核算</TabsTrigger>
        <TabsTrigger value="monthly-sku">月度 SKU 分析</TabsTrigger>
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
  )
}
