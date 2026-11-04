'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import { Calculator, Package, PenLine } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ManualCalculationPanel from './components/manual-calculation-panel'
import MonthlySkuAnalysisPanel from './components/monthly-sku-analysis-panel'
import ProductAnalysisPanel from './components/product-analysis-panel'
import styles from './product-analysis-warm.module.css'

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
    <div className={styles.page} data-warm-product-analysis="true">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
        className={styles.tabs}
      >
        <TabsList className={styles.tabList} data-warm-tablist="true">
          {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className={styles.tab}>
              <Icon aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="product-analysis" className={styles.tabContent}>
          <ProductAnalysisPanel session={session} />
        </TabsContent>

        <TabsContent value="manual" className={styles.tabContent}>
          <ManualCalculationPanel />
        </TabsContent>

        <TabsContent value="monthly-sku" className={styles.tabContent}>
          <MonthlySkuAnalysisPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
