'use client'

import { useEffect, useState, useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useNotifications } from '@/components/notifications'
import { fetchCurrentPeriod } from '@/lib/inspection-api'
import InspectionOverview from './components/inspection-overview'
import InspectionForm from './components/inspection-form'
import InspectionHistory from './components/inspection-history'

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
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="history">历史记录</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {currentPeriodId && (
            <InspectionOverview
              periodId={currentPeriodId}
              refreshKey={refreshKey}
              onSelectProject={handleSelectProject}
            />
          )}
        </TabsContent>

        <TabsContent value="history">
          {currentPeriodId && (
            <InspectionHistory periodId={currentPeriodId} />
          )}
        </TabsContent>
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