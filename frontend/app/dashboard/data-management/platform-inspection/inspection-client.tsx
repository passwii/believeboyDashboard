'use client'

import { useEffect, useState, useCallback } from 'react'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { useNotifications } from '@/components/notifications'
import { fetchCurrentPeriod } from '@/lib/inspection-api'
import InspectionOverview from './components/inspection-overview'
import InspectionForm from './components/inspection-form'
import InspectionHistory from './components/inspection-history'

const INSPECTION_TAB_ORDER = ['overview', 'history'] as const

export default function InspectionClient() {
  const { notify } = useNotifications()
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [currentPeriodId, setCurrentPeriodId] = useState<number | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Fetch current period on mount
  useEffect(() => {
    async function loadCurrentPeriod() {
      try {
        const period = await fetchCurrentPeriod()
        setCurrentPeriodId(period.id)
      } catch (e) {
        notify({
          type: 'error',
          title: '加载失败',
          message: '无法获取当前巡检周期',
        })
      }
    }
    void loadCurrentPeriod()
  }, [notify])

  const handleSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId)
    setIsDialogOpen(true)
  }, [])

  const handleDialogClose = useCallback(() => {
    setIsDialogOpen(false)
    setSelectedProjectId(null)
    setRefreshKey((k) => k + 1)
  }, [])

  const handleSubmitSuccess = useCallback(() => {
    setIsDialogOpen(false)
    setSelectedProjectId(null)
    setRefreshKey((k) => k + 1)
  }, [])

  const handleBackToOverview = useCallback(() => {
    setActiveTab('overview')
  }, [])

  return (
    <div className="w-full space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsMotionGroup id="inspection-tabs">
          <TabsList>
            <SlidingTabsTrigger value="overview" activeValue={activeTab} layoutId="inspection-tab-indicator">概览</SlidingTabsTrigger>
            <SlidingTabsTrigger value="history" activeValue={activeTab} layoutId="inspection-tab-indicator">历史记录</SlidingTabsTrigger>
          </TabsList>
        </TabsMotionGroup>

        <DirectionalTabTransition value={activeTab} order={INSPECTION_TAB_ORDER}>
          <TabsContent forceMount value={activeTab} className="mt-0">
            {activeTab === 'overview' ? (
              currentPeriodId && (
                <InspectionOverview
                  periodId={currentPeriodId}
                  refreshKey={refreshKey}
                  onSelectProject={handleSelectProject}
                />
              )
            ) : (
              currentPeriodId && (
                <InspectionHistory periodId={currentPeriodId} />
              )
            )}
          </TabsContent>
        </DirectionalTabTransition>
      </Tabs>

      {/* Edit Dialog */}
      {currentPeriodId && selectedProjectId && (
        <InspectionForm
          periodId={currentPeriodId}
          projectId={selectedProjectId}
          open={isDialogOpen}
          onClose={handleDialogClose}
          onBack={handleBackToOverview}
          onSubmitSuccess={handleSubmitSuccess}
        />
      )}
    </div>
  )
}