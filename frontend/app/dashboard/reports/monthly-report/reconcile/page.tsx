'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
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
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'
import { useSharedReportProject } from '../shared-project'
import styles from './reconcile-warm.module.css'

/**
 * BLF-964 · reconcile 页外层承载：
 *  - 内层 auto / manual 双 tab 切换
 *  - 筛选状态（项目 / 站点）上移到页面层，经 HeaderSlot 注入 Top Header 中段
 *  - 手动核对 tab 下清空 slot（useHeaderSlot(null) 自动清除语义）
 *  - 刷新经 useHeaderRefresh 注册，移动端条经 useMobileFilterStrip 下迁
 */
export default function ReconcilePage() {
  const { data: session, status: sessionStatus } = useSession()
  const [activeTab, setActiveTab] = useState<'auto' | 'manual'>('auto')
  // BLF-1344：本页项目选择原本只存组件 state，切 tab 就丢；接到月报板块共享记忆上
  const [explicitProjectId, setProjectId] = useState('')
  const { projectId, ready: sharedProjectReady, forgetProjectId } = useSharedReportProject({
    projectId: explicitProjectId,
    setProjectId,
  })
  const [country, setCountry] = useState('US')
  const [loading, setLoading] = useState(false)

  // BLF-1344（评审阻塞项）· 可见项目白名单：
  // available-reports 后端路由只做登录保护、不按操作者校验项目权限，所以「用哪个项目
  // id 发请求」必须先在前端确认属于当前操作者可见项目（/projects/manage，与项目下拉同源）。
  // 覆盖三种会拿到不可见 id 的场景：换账号后的残留记忆、权限被收回、项目下架。
  const [visibleProjectIds, setVisibleProjectIds] = useState<string[]>([])
  const [projectsChecked, setProjectsChecked] = useState(false)

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let active = true
    setProjectsChecked(false)
    fetchManagedProjectsCached<Array<{ id?: number | null }>>(session)
      .then((rows) => {
        if (!active) return
        setVisibleProjectIds(
          rows.filter((row) => typeof row.id === 'number' && row.id > 0).map((row) => String(row.id))
        )
        setProjectsChecked(true)
      })
      .catch(() => {
        if (!active) return
        // 列表拿不到 = 无法确认权限：按「没有可见项目」处理，宁可不发请求
        setVisibleProjectIds([])
        setProjectsChecked(true)
      })
    return () => {
      active = false
    }
  }, [session, sessionStatus])

  // 记忆 / URL 里的项目不在可见列表里 → 清掉记忆并回退到第一个可见项目（没有就清空）
  useEffect(() => {
    if (!sharedProjectReady || !projectsChecked) return
    if (!projectId || projectId === 'all') return
    if (visibleProjectIds.includes(projectId)) return
    forgetProjectId()
    setProjectId(visibleProjectIds[0] ?? '')
  }, [sharedProjectReady, projectsChecked, visibleProjectIds, projectId, forgetProjectId])

  // 交给 auto tab 的项目 id：确认可见之后才给，未校验完 / 未通过一律为空（不发请求）
  const requestProjectId =
    projectId === 'all' || (projectsChecked && visibleProjectIds.includes(projectId))
      ? projectId
      : ''

  // Bridge：auto tab 把 fetchAvailableReports 注册到此 ref，供 head 刷新按钮调用
  const fetchAvailableReportsRef = useRef<() => void>(() => {})

  // Header 插槽：仅 auto tab 注册；切到 manual 传 null 自动清除。
  // BLF-1344：共享记忆读出 / 可见项目校验完成前不挂 HeaderProjectSelect——它在 value
  // 为空时会自动选中第一个项目，先挂会拿这个未经确认的默认值盖掉其它 tab 刚选的项目。
  const filterControlsReady = sharedProjectReady && projectsChecked
  const headerSlotPortal = useHeaderSlot(
    activeTab === 'auto' && filterControlsReady ? (
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

  // 移动端折叠条：仅 auto tab 显示（同样等共享记忆读出、可见项目校验完成后再挂项目控件）
  const mobileFilterStrip = useMobileFilterStrip(
    activeTab === 'auto' && filterControlsReady ? (
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
    <div className={styles.page} data-warm-monthly-reconcile="true">
      {headerSlotPortal}
      {mobileFilterStrip}
      <Tabs
        defaultValue="auto"
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'auto' | 'manual')}
        className={styles.tabs}
      >
        {/* 与月报外层 Tab 保持同一 Warm 分段控件规格。 */}
        <TabsList className={styles.tabList} data-warm-tablist="true">
          <TabsTrigger value="auto" className={styles.tab}>
            <Zap aria-hidden />
            自动核对
          </TabsTrigger>
          <TabsTrigger value="manual" className={styles.tab}>
            <PenLine aria-hidden />
            手动核对
          </TabsTrigger>
        </TabsList>

        <TabsContent value="auto">
          <AutoReconcileTab
            projectId={requestProjectId}
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
