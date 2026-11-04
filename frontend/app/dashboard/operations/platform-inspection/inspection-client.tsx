'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { History, LayoutDashboard } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { fetchCurrentPeriod } from '@/lib/inspection-api'
import InspectionOverview from './components/inspection-overview'
import InspectionForm from './components/inspection-form'
import InspectionHistory from './components/inspection-history'
import styles from './platform-inspection-warm.module.css'

export default function InspectionClient() {
  const { notify } = useNotifications()
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [currentPeriodId, setCurrentPeriodId] = useState<number | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [periodLoading, setPeriodLoading] = useState(false)

  // 拉取当前巡检周期（mount 与全局刷新共用；刷新时重取以捕获周期滚动）
  const loadCurrentPeriod = useCallback(async () => {
    setPeriodLoading(true)
    try {
      const period = await fetchCurrentPeriod()
      setCurrentPeriodId(period.id)
    } catch (e) {
      notify({
        type: 'error',
        title: '加载失败',
        message: '无法获取当前巡检周期',
      })
    } finally {
      setPeriodLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void loadCurrentPeriod()
  }, [loadCurrentPeriod])

  // —— Header 化：全局刷新（operations header 迁移 Batch C）——
  // 本页无筛选控件可上移。刷新 = bump refreshKey（概览/历史子组件按 refreshKey
  // 重拉各自数据集）+ 重取 currentPeriod（周期可能已滚动）。
  // ref 桥接防过期闭包；periodLoading 上报头部刷新按钮。
  const handleHeaderRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
    void loadCurrentPeriod()
  }, [loadCurrentPeriod])
  const handleHeaderRefreshRef = useRef(handleHeaderRefresh)
  handleHeaderRefreshRef.current = handleHeaderRefresh
  useHeaderRefresh(() => handleHeaderRefreshRef.current(), { loading: periodLoading })

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
    <div
      className={styles.page}
      data-testid="platform-inspection-page"
      data-warm-platform-inspection="true"
    >
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className={styles.tabsList}>
          <TabsTrigger value="overview">
            <LayoutDashboard aria-hidden />
            概览
          </TabsTrigger>
          <TabsTrigger value="history">
            <History aria-hidden />
            历史记录
          </TabsTrigger>
        </TabsList>

        <TabsContent forceMount value={activeTab} className={styles.tabPanel}>
          {activeTab === 'overview'
            ? currentPeriodId && (
                <InspectionOverview
                  periodId={currentPeriodId}
                  refreshKey={refreshKey}
                  onSelectProject={handleSelectProject}
                />
              )
            : currentPeriodId && (
                <InspectionHistory periodId={currentPeriodId} refreshKey={refreshKey} />
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
