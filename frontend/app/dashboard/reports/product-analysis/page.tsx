'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { Calculator, Package, PenLine } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ManualCalculationPanel from './components/manual-calculation-panel'
import MonthlySkuAnalysisPanel from './components/monthly-sku-analysis-panel'
import ProductAnalysisPanel from './components/product-analysis-panel'

// BLF-883 全局统一：Tab 条一律走 variant="term"（h-8 / 零圆角 / 1px 边界 /
// 激活态 term-raised + accent 发光指示条），并为每个 tab 前置 icon。
const TAB_ITEMS = [
  { value: 'product-analysis', label: '产品分析核算', icon: Calculator },
  { value: 'manual', label: '手动核算', icon: PenLine },
  { value: 'monthly-sku', label: '月度 SKU 分析', icon: Package },
] as const

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
        <TabsList variant="term" className="w-fit justify-start">
          {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} variant="term">
              <Icon aria-hidden />
              {label}
            </TabsTrigger>
          ))}
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
