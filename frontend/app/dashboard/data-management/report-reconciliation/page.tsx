'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'

export default function ReportReconciliationPage() {
  return (
    <div className='w-full space-y-6'>
      <Tabs defaultValue='auto' className='w-full'>
        <TabsList className='mb-6'>
          <TabsTrigger value='auto'>自动核对</TabsTrigger>
          <TabsTrigger value='manual'>手动核对</TabsTrigger>
        </TabsList>

        <TabsContent value='auto'>
          <AutoReconcileTab />
        </TabsContent>

        <TabsContent value='manual'>
          <ManualReconcileTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
