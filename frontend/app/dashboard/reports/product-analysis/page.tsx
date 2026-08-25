'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'

import { PageHeader } from '@/components/ui/page-header'
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
    <div className="space-y-6">
      <PageHeader
        title="产品分析"
        description="按产品维度核算利润与定价，支持手动核算与月度 SKU 分析。"
      />

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
    </div>
  )
}
