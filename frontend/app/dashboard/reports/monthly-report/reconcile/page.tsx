'use client'

import { useRef, useState } from 'react'
import { PenLine, Zap } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { HeaderProjectSelect, HeaderCountrySelect } from '@/components/terminal/header-filter-suite'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'
import { useSharedReportProject } from '../shared-project'

/**
 * BLF-964 · reconcile 页外层承载：
 *  - 内层 auto / manual 双 tab 切换
 *  - 筛选状态（项目 / 站点）上移到页面层，经 HeaderSlot 注入 Top Header 中段
 *  - 手动核对 tab 下清空 slot（useHeaderSlot(null) 自动清除语义）
 *  - 刷新经 useHeaderRefresh 注册，移动端条经 useMobileFilterStrip 下迁
 */
export default function ReconcilePage() {
  const [activeTab, setActiveTab] = useState<'auto' | 'manual'>('auto')
  // BLF-1344：本页项目选择原本只存组件 state，切 tab 就丢；接到月报板块共享记忆上
  const [explicitProjectId, setProjectId] = useState('')
  const { projectId, ready: sharedProjectReady } = useSharedReportProject({
    projectId: explicitProjectId,
    setProjectId,
  })
  const [country, setCountry] = useState('US')
  const [loading, setLoading] = useState(false)

  // Bridge：auto tab 把 fetchAvailableReports 注册到此 ref，供 head 刷新按钮调用
  const fetchAvailableReportsRef = useRef<() => void>(() => {})

  // Header 插槽：仅 auto tab 注册；切到 manual 传 null 自动清除。
  // BLF-1344：共享记忆读出前不挂 HeaderProjectSelect——它在 value 为空时会自动选中
  // 第一个项目，先挂会拿这个未经确认的默认值盖掉其它 tab 刚选的项目。
  const headerSlotPortal = useHeaderSlot(
    activeTab === 'auto' && sharedProjectReady ? (
      <HeaderFilterControls
        isMobileView={false}
        controls={
          <>
            <HeaderProjectSelect value={projectId} onChange={setProjectId} />
            <HeaderCountrySelect value={country} onChange={setCountry} />
          </>
        }
      />
    ) : null
  )

  // 全局刷新：触发 auto tab 的 fetchAvailableReports
  useHeaderRefresh(() => fetchAvailableReportsRef.current(), { loading })

  // 移动端折叠条：仅 auto tab 显示（同样等共享记忆读出后再挂项目控件）
  const mobileFilterStrip = useMobileFilterStrip(
    activeTab === 'auto' && sharedProjectReady ? (
      <MobileFilterStrip
        summary={`${projectId || '未选项目'} · ${country === 'ALL' ? '全部站点' : country}`}
        controls={
          <>
            <HeaderProjectSelect value={projectId} onChange={setProjectId} />
            <HeaderCountrySelect value={country} onChange={setCountry} />
          </>
        }
      />
    ) : null
  )

  return (
    <div className="w-full space-y-6">
      {headerSlotPortal}
      {mobileFilterStrip}
      <Tabs
        defaultValue="auto"
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'auto' | 'manual')}
        className="w-full"
      >
        {/* BLF-883 全局统一：variant="term" + 前置 icon（与外层月报 Tab 同规格） */}
        <TabsList variant="term" className="mb-6 w-fit justify-start">
          <TabsTrigger value="auto" variant="term">
            <Zap aria-hidden />
            自动核对
          </TabsTrigger>
          <TabsTrigger value="manual" variant="term">
            <PenLine aria-hidden />
            手动核对
          </TabsTrigger>
        </TabsList>

        <TabsContent value="auto">
          <AutoReconcileTab
            projectId={projectId}
            setProjectId={setProjectId}
            country={country}
            setCountry={setCountry}
            loading={loading}
            setLoading={setLoading}
            fetchAvailableReportsRef={fetchAvailableReportsRef}
          />
        </TabsContent>

        <TabsContent value="manual">
          <ManualReconcileTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
