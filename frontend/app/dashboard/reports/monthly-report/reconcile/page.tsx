'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { PenLine, Zap } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { COUNTRY_LABELS } from '@/lib/country'
import AutoReconcileTab from './auto-reconcile-tab'
import ManualReconcileTab from './manual-reconcile-tab'
import { useSharedReportProject } from '../shared-project'
import styles from './reconcile-warm.module.css'

const COUNTRY_OPTIONS = [
  { value: 'ALL', label: '全部站点' },
  ...Object.entries(COUNTRY_LABELS).map(([code, name]) => ({
    value: code,
    label: `${name} (${code})`,
  })),
]

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
  const [visibleProjects, setVisibleProjects] = useState<Array<{ id: string; name: string }>>([])
  const [projectsChecked, setProjectsChecked] = useState(false)

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let active = true
    setProjectsChecked(false)
    fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session)
      .then((rows) => {
        if (!active) return
        const projects = rows
          .filter((row) => typeof row.id === 'number' && row.id > 0)
          .map((row) => ({ id: String(row.id), name: row.name }))
        setVisibleProjects(projects)
        setVisibleProjectIds(projects.map((row) => row.id))
        setProjectsChecked(true)
      })
      .catch(() => {
        if (!active) return
        // 列表拿不到 = 无法确认权限：按「没有可见项目」处理，宁可不发请求
        setVisibleProjectIds([])
        setVisibleProjects([])
        setProjectsChecked(true)
      })
    return () => {
      active = false
    }
  }, [session, sessionStatus])

  // 记忆 / URL 里的项目不在可见列表里 → 清掉记忆并回退到第一个可见项目（没有就清空）
  useEffect(() => {
    if (!sharedProjectReady || !projectsChecked) return
    if (projectId === 'all') return
    if (projectId && visibleProjectIds.includes(projectId)) return
    if (projectId) forgetProjectId()
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
  // BLF-1344：共享记忆读出 / 可见项目校验完成前不挂项目控件，避免拿未经确认的默认值
  // 盖掉其它 tab 刚选的项目；校验完成后仍保留“空值回退第一个可见项目”的既有行为。
  const filterControlsReady = sharedProjectReady && projectsChecked
  const headerSlotPortal = useHeaderSlot(
    activeTab === 'auto' && filterControlsReady ? (
      <div className={styles.headerFilters} data-warm-header-filters="true">
        <select
          aria-label="项目筛选"
          className={styles.headerSelect}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="all">全部项目</option>
          {visibleProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          aria-label="站点筛选"
          className={styles.headerCountry}
          value={country}
          onChange={(event) => setCountry(event.target.value)}
        >
          {COUNTRY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
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
            <select
              aria-label="项目筛选"
              className={styles.mobileHeaderSelect}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="all">全部项目</option>
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <select
              aria-label="站点筛选"
              className={styles.mobileHeaderSelect}
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            >
              {COUNTRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
