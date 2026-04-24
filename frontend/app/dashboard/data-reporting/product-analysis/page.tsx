'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ManualCalculationPanel from './components/manual-calculation-panel'
import ProductCalculationPanel from './components/product-calculation-panel'

export default function ProductAnalysisPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<'product-calculation' | 'manual'>('product-calculation')

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="space-y-4">
      <TabsList>
        <TabsTrigger value="product-calculation">产品核算</TabsTrigger>
        <TabsTrigger value="manual">手动核算</TabsTrigger>
      </TabsList>

      <TabsContent value="product-calculation" className="space-y-0">
        <ProductCalculationPanel session={session} />
      </TabsContent>

      <TabsContent value="manual" className="space-y-0">
        <ManualCalculationPanel
          projects={[]}
          projectsLoading={false}
          projectLoadError={null}
        />
      </TabsContent>
    </Tabs>
  )
}
