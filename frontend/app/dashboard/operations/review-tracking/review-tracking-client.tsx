'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  HeaderProjectSelect,
  HeaderSlotSelect,
  TERM_HEADER_W_SM,
} from '@/components/terminal/header-filter-suite'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import {
  type CrawlRunRow,
  type ExternalTarget,
  type RatingSnapshotPoint,
  type ReviewRow,
  type ReviewTarget,
  type VisibilityStatus,
  addExternalLink,
  createExternalTarget,
  describeReviewTrackingError,
  fetchCrawlRuns,
  fetchExternalTargets,
  fetchRatingSnapshots,
  fetchReviews,
  fetchTargets,
  hasMorePage,
  removeExternalLink,
} from '@/lib/review-tracking-api'
import { fetchShopOptions, type ShopOption } from '@/lib/review-tracking-shops'
import { CrawlHealthPanel } from './components/crawl-health-panel'
import { ExternalTargetsPanel } from './components/external-targets-panel'
import { RatingTrendPanel } from './components/rating-trend-panel'
import { ReviewsTable } from './components/reviews-table'
import { TargetSelector } from './components/target-selector'

/**
 * 评论追踪运营页（阶段 C，BLF-1377）。
 *
 * 页面只做编排：筛选、目标选择、各区块数据拉取与错误分流；口径映射全部在
 * `lib/review-tracking-api.ts`（缺失值不渲染成 0、星数三档口径、状态文案）。
 *
 * 权限：非运营/管理员 → 后端 403，页面显示权限说明且不重试；
 *       不可见项目的内部目标 → 404，显示「目标不存在或无权访问」。
 */
const REVIEW_PAGE_SIZE = 50
const RUN_PAGE_SIZE = 20

type PageTab = 'trend' | 'reviews' | 'health' | 'external'
const TAB_ORDER: PageTab[] = ['trend', 'reviews', 'health', 'external']

type ManagedProject = { id?: number | null; name: string }

interface PermissionState {
  status: number
  title: string
  message: string
}

export default function ReviewTrackingClient() {
  const { notify } = useNotifications()
  const { data: session, status: sessionStatus } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)

  const [activeTab, setActiveTab] = useState<PageTab>('trend')
  const [projectId, setProjectId] = useState('all')
  const [marketplace, setMarketplace] = useState('ALL')
  const [targetStatus, setTargetStatus] = useState('active')

  const [projects, setProjects] = useState<ManagedProject[]>([])
  const [targets, setTargets] = useState<ReviewTarget[]>([])
  const [targetsLoading, setTargetsLoading] = useState(true)
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null)
  const [permission, setPermission] = useState<PermissionState | null>(null)

  const [snapshots, setSnapshots] = useState<RatingSnapshotPoint[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [reviews, setReviews] = useState<ReviewRow[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(false)
  const [reviewOffset, setReviewOffset] = useState(0)
  const [visibility, setVisibility] = useState<VisibilityStatus | 'all'>('all')
  const [runs, setRuns] = useState<CrawlRunRow[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  // ── 详情请求防串台（BLF-1377 / B4） ──
  // 运营快速从 A 切到 B 时，A 的响应可能后到。若直接 `setX(await fetchX(A))`，
  // 页面会出现「标题是 B、图表 / 评论 / 运行记录是 A」的串台——比空态糟得多。
  // 每个 loader 发请求时领一个递增令牌，响应回来（含失败）时令牌已不是最新、
  // 或当前选中目标已经不是发起时的目标，就整批丢弃（连 loading 也不回落，交给新请求）。
  const selectedTargetRef = useRef<number | null>(selectedTargetId)
  selectedTargetRef.current = selectedTargetId
  const snapshotsRequestRef = useRef(0)
  const reviewsRequestRef = useRef(0)
  const runsRequestRef = useRef(0)

  const [externalTargets, setExternalTargets] = useState<ExternalTarget[]>([])
  const [externalLoading, setExternalLoading] = useState(false)
  const [shopOptions, setShopOptions] = useState<ShopOption[]>([])
  const [shopOptionsLoading, setShopOptionsLoading] = useState(true)
  const [writeBusy, setWriteBusy] = useState(false)

  const projectNameById = useMemo(
    () =>
      new Map(
        projects
          .filter((project): project is { id: number; name: string } => typeof project.id === 'number')
          .map((project) => [project.id, project.name])
      ),
    [projects]
  )
  // 项目名只用于展示：放 ref 避免「项目列表加载完成 → 映射新引用 → 重新拉目标」的双请求。
  const projectNameRef = useRef(projectNameById)
  projectNameRef.current = projectNameById

  const describeError = useCallback(
    (error: unknown) => {
      const described = describeReviewTrackingError(error)
      if (described.status === 401 || described.status === 403) {
        setPermission({ status: described.status, title: described.title, message: described.message })
        return true
      }
      return false
    },
    []
  )

  // ── 项目列表（外部竞品关联店铺也需要） ──
  useEffect(() => {
    if (sessionStatus === 'loading') return
    let active = true
    fetchManagedProjectsCached<ManagedProject[]>(session)
      .then((rows) => {
        if (active) setProjects(rows)
      })
      .catch(() => {
        if (active) setProjects([])
      })
    return () => {
      active = false
    }
  }, [session, sessionStatus])

  // ── 目标列表 ──
  const loadTargets = useCallback(async () => {
    setTargetsLoading(true)
    try {
      const rows = await fetchTargets(
        {
          projectId: projectId === 'all' ? null : Number(projectId),
          marketplace: marketplace === 'ALL' ? null : marketplace,
          isActive: targetStatus === 'all' ? null : targetStatus === 'active',
        },
        projectNameRef.current
      )
      setTargets(rows)
      setPermission(null)
      setSelectedTargetId((current) => {
        if (current !== null && rows.some((row) => row.id === current)) return current
        return rows[0]?.id ?? null
      })
    } catch (error) {
      if (!describeError(error)) {
        const described = describeReviewTrackingError(error)
        notify({ type: 'error', title: described.title, message: described.message })
      }
      setTargets([])
    } finally {
      setTargetsLoading(false)
    }
  }, [describeError, marketplace, notify, projectId, targetStatus])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    void loadTargets()
  }, [loadTargets, sessionStatus])

  // ── 目标详情：快照 / 评论 / 运行 ──
  // `stale()`：该请求是否已被更新的请求取代、或已切到别的目标。
  const isStale = useCallback(
    (requestId: number, latestRequestId: number, targetId: number) =>
      latestRequestId !== requestId || selectedTargetRef.current !== targetId,
    []
  )

  const loadSnapshots = useCallback(
    async (targetId: number) => {
      const requestId = ++snapshotsRequestRef.current
      const stale = () => isStale(requestId, snapshotsRequestRef.current, targetId)
      setSnapshotsLoading(true)
      try {
        const points = await fetchRatingSnapshots(targetId, { limit: 200 })
        if (stale()) return
        setSnapshots(points)
      } catch (error) {
        // 已切走的请求不再弹错：A 的 404 不该在 B 的页面上报
        if (stale()) return
        if (!describeError(error)) {
          const described = describeReviewTrackingError(error)
          notify({ type: 'error', title: described.title, message: described.message })
        }
        setSnapshots([])
      } finally {
        if (!stale()) setSnapshotsLoading(false)
      }
    },
    [describeError, isStale, notify]
  )

  const loadReviews = useCallback(
    async (targetId: number, offset: number, nextVisibility: VisibilityStatus | 'all') => {
      // 评论的令牌同时覆盖 offset / visibility：翻页或换筛选时旧页的响应同样作废。
      const requestId = ++reviewsRequestRef.current
      const stale = () => isStale(requestId, reviewsRequestRef.current, targetId)
      setReviewsLoading(true)
      try {
        const rows = await fetchReviews(targetId, {
          visibilityStatus: nextVisibility === 'all' ? null : nextVisibility,
          limit: REVIEW_PAGE_SIZE,
          offset,
        })
        if (stale()) return
        setReviews(rows)
      } catch (error) {
        if (stale()) return
        if (!describeError(error)) {
          const described = describeReviewTrackingError(error)
          notify({ type: 'error', title: described.title, message: described.message })
        }
        setReviews([])
      } finally {
        if (!stale()) setReviewsLoading(false)
      }
    },
    [describeError, isStale, notify]
  )

  const loadRuns = useCallback(
    async (targetId: number) => {
      const requestId = ++runsRequestRef.current
      const stale = () => isStale(requestId, runsRequestRef.current, targetId)
      setRunsLoading(true)
      try {
        const rows = await fetchCrawlRuns(targetId, { limit: RUN_PAGE_SIZE })
        if (stale()) return
        setRuns(rows)
      } catch (error) {
        if (stale()) return
        if (!describeError(error)) {
          const described = describeReviewTrackingError(error)
          notify({ type: 'error', title: described.title, message: described.message })
        }
        setRuns([])
      } finally {
        if (!stale()) setRunsLoading(false)
      }
    },
    [describeError, isStale, notify]
  )

  useEffect(() => {
    if (selectedTargetId === null) {
      // 目标被清空时让在途请求一并失效，避免它们回填已清空的数据
      snapshotsRequestRef.current += 1
      reviewsRequestRef.current += 1
      runsRequestRef.current += 1
      setSnapshots([])
      setReviews([])
      setRuns([])
      setSnapshotsLoading(false)
      setReviewsLoading(false)
      setRunsLoading(false)
      return
    }
    void loadSnapshots(selectedTargetId)
  }, [loadSnapshots, selectedTargetId])

  useEffect(() => {
    if (selectedTargetId === null) return
    setReviewOffset(0)
    void loadReviews(selectedTargetId, 0, visibility)
  }, [loadReviews, selectedTargetId, visibility])

  useEffect(() => {
    if (selectedTargetId === null) return
    void loadRuns(selectedTargetId)
  }, [loadRuns, selectedTargetId])

  // ── 外部竞品 ──
  const loadExternalTargets = useCallback(async () => {
    setExternalLoading(true)
    try {
      setExternalTargets(await fetchExternalTargets())
    } catch (error) {
      if (!describeError(error)) {
        const described = describeReviewTrackingError(error)
        notify({ type: 'error', title: described.title, message: described.message })
      }
      setExternalTargets([])
    } finally {
      setExternalLoading(false)
    }
  }, [describeError, notify])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    void loadExternalTargets()
  }, [loadExternalTargets, sessionStatus])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let active = true
    setShopOptionsLoading(true)
    fetchShopOptions(session)
      .then((options) => {
        if (active) setShopOptions(options)
      })
      .catch(() => {
        if (active) setShopOptions([])
      })
      .finally(() => {
        if (active) setShopOptionsLoading(false)
      })
    return () => {
      active = false
    }
  }, [session, sessionStatus])

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadTargets(), loadExternalTargets()])
    if (selectedTargetId !== null) {
      await Promise.all([
        loadSnapshots(selectedTargetId),
        loadReviews(selectedTargetId, reviewOffset, visibility),
        loadRuns(selectedTargetId),
      ])
    }
  }, [
    loadExternalTargets,
    loadReviews,
    loadRuns,
    loadSnapshots,
    loadTargets,
    reviewOffset,
    selectedTargetId,
    visibility,
  ])

  const refreshRef = useRef(handleRefresh)
  refreshRef.current = handleRefresh
  useHeaderRefresh(() => refreshRef.current(), {
    loading: targetsLoading || snapshotsLoading || reviewsLoading || runsLoading || externalLoading,
  })

  const notifyWriteError = useCallback(
    (error: unknown) => {
      if (describeError(error)) return
      const described = describeReviewTrackingError(error)
      notify({ type: 'error', title: described.title, message: described.message })
    },
    [describeError, notify]
  )

  const handleCreateExternal = useCallback(
    async (payload: {
      marketplace: string
      asin: string
      shopId: number | null
      displayName: string | null
    }) => {
      setWriteBusy(true)
      try {
        await createExternalTarget(payload)
        // 左侧目标列表也要刷新：刚登记的竞品（或 upsert 复活的停用目标）否则在
        // 「仅启用」筛选下选不到，得手动刷整页。
        await Promise.all([loadExternalTargets(), loadTargets()])
        notify({ type: 'success', title: '外部竞品已登记' })
      } finally {
        setWriteBusy(false)
      }
    },
    [loadExternalTargets, loadTargets, notify]
  )

  const handleLink = useCallback(
    async (targetId: number, shopId: number) => {
      setWriteBusy(true)
      try {
        await addExternalLink(targetId, shopId)
        await loadExternalTargets()
        notify({ type: 'success', title: '店铺已关联', message: '若该店铺曾被移除，关联已复活并沿用历史。' })
      } finally {
        setWriteBusy(false)
      }
    },
    [loadExternalTargets, notify]
  )

  const handleUnlink = useCallback(
    async (targetId: number, linkId: number) => {
      setWriteBusy(true)
      try {
        await removeExternalLink(targetId, linkId)
        await loadExternalTargets()
        notify({
          type: 'success',
          title: '关联已移除',
          message: '只是软删除：追踪历史保留，重新关联同一店铺会复活。',
        })
      } finally {
        setWriteBusy(false)
      }
    },
    [loadExternalTargets, notify]
  )

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets]
  )

  // ── Header 插槽（桌面 / 移动） ──
  const filters = (
    <>
      <HeaderProjectSelect value={projectId} onChange={setProjectId} />
      <HeaderSlotSelect
        value={marketplace}
        onChange={setMarketplace}
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
        options={[
          { value: 'ALL', label: '全部站点' },
          { value: 'US', label: '美国站 (US)' },
          { value: 'DE', label: '德国站 (DE)' },
          { value: 'UK', label: '英国站 (UK)' },
        ]}
      />
      <HeaderSlotSelect
        value={targetStatus}
        onChange={setTargetStatus}
        widthClass={TERM_HEADER_W_SM}
        title="目标状态"
        options={[
          { value: 'active', label: '仅启用' },
          { value: 'inactive', label: '仅停用' },
          { value: 'all', label: '全部状态' },
        ]}
      />
    </>
  )

  const desktopSlot = useHeaderSlot(<HeaderFilterControls isMobileView={false} controls={filters} />)
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={`${projectId === 'all' ? '全部项目' : (projectNameById.get(Number(projectId)) ?? projectId)} · ${
        marketplace === 'ALL' ? '全部站点' : marketplace
      }`}
      controls={<MobileFilterWide>{filters}</MobileFilterWide>}
    />
  )

  if (permission) {
    return (
      <>
        {desktopSlot}
        {mobileStrip}
        <div className="w-full">
          <DataTableCard>
            <DataTableCardBody>
              <EmptyState
                icon="file"
                message={`${permission.title}：${permission.message}`}
                className="py-20"
              />
            </DataTableCardBody>
          </DataTableCard>
        </div>
      </>
    )
  }

  return (
    <>
      {desktopSlot}
      {mobileStrip}
      <div className="w-full space-y-4">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <aside>
            <TargetSelector
              targets={targets}
              loading={targetsLoading}
              selectedId={selectedTargetId}
              onSelect={setSelectedTargetId}
            />
          </aside>

          <section className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h1 className="truncate font-mono text-sm font-semibold text-term-text">
                  {selectedTarget ? selectedTarget.displayName : '未选择目标'}
                </h1>
                {selectedTarget ? (
                  <p className="mt-0.5 font-mono text-[10px] text-term-muted">
                    {selectedTarget.kindLabel} · {selectedTarget.marketplace} ·{' '}
                    {selectedTarget.asin || '代表 ASIN 未设置'} · {selectedTarget.projectName}
                  </p>
                ) : null}
              </div>
              {selectedTarget ? (
                <Badge variant="outline" className="border-term-border text-term-muted">
                  {selectedTarget.isActive ? '启用中' : '已停用'}
                </Badge>
              ) : null}
            </div>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PageTab)}>
              <TabsMotionGroup id="review-tracking-tabs">
                <TabsList variant="term" className="w-fit max-w-full justify-start">
                  <SlidingTabsTrigger
                    value="trend"
                    activeValue={activeTab}
                    layoutId="review-tracking-tab-indicator"
                    variant="term"
                  >
                    评分趋势
                  </SlidingTabsTrigger>
                  <SlidingTabsTrigger
                    value="reviews"
                    activeValue={activeTab}
                    layoutId="review-tracking-tab-indicator"
                    variant="term"
                  >
                    评论明细
                  </SlidingTabsTrigger>
                  <SlidingTabsTrigger
                    value="health"
                    activeValue={activeTab}
                    layoutId="review-tracking-tab-indicator"
                    variant="term"
                  >
                    采集健康度
                  </SlidingTabsTrigger>
                  <SlidingTabsTrigger
                    value="external"
                    activeValue={activeTab}
                    layoutId="review-tracking-tab-indicator"
                    variant="term"
                  >
                    外部竞品
                  </SlidingTabsTrigger>
                </TabsList>
              </TabsMotionGroup>

              <DirectionalTabTransition value={activeTab} order={TAB_ORDER}>
                <TabsContent forceMount value={activeTab}>
                  {activeTab === 'trend' ? (
                    <DataTableCard>
                      <DataTableCardHeader
                        title="评分趋势"
                        description="每个业务日期一条快照；同日重试只更新当天，不在图上重复出现"
                      />
                      <DataTableCardBody>
                        {selectedTargetId === null ? (
                          <EmptyState icon="database" message="请先在左侧选择一个追踪目标" className="py-16" />
                        ) : snapshotsLoading ? (
                          <Skeleton className="h-[300px] w-full rounded-none" />
                        ) : snapshots.length === 0 ? (
                          <EmptyState
                            icon="database"
                            message="还没有评分快照（等待采集端接入）；采集上线后这里会按天积累历史。"
                            className="py-16"
                          />
                        ) : (
                          <RatingTrendPanel points={snapshots} />
                        )}
                      </DataTableCardBody>
                    </DataTableCard>
                  ) : null}

                  {activeTab === 'reviews' ? (
                    <DataTableCard>
                      <DataTableCardHeader
                        title="评论明细"
                        description="按可见性筛选；正文可能是抓取当时的快照"
                      />
                      <DataTableCardBody>
                        {selectedTargetId === null ? (
                          <EmptyState icon="database" message="请先在左侧选择一个追踪目标" className="py-16" />
                        ) : (
                          <ReviewsTable
                            rows={reviews}
                            loading={reviewsLoading}
                            hasMore={hasMorePage(reviews.length, REVIEW_PAGE_SIZE)}
                            offset={reviewOffset}
                            limit={REVIEW_PAGE_SIZE}
                            visibility={visibility}
                            onVisibilityChange={setVisibility}
                            onPrevPage={() => {
                              const next = Math.max(0, reviewOffset - REVIEW_PAGE_SIZE)
                              setReviewOffset(next)
                              void loadReviews(selectedTargetId, next, visibility)
                            }}
                            onNextPage={() => {
                              if (!hasMorePage(reviews.length, REVIEW_PAGE_SIZE)) return
                              const next = reviewOffset + REVIEW_PAGE_SIZE
                              setReviewOffset(next)
                              void loadReviews(selectedTargetId, next, visibility)
                            }}
                          />
                        )}
                      </DataTableCardBody>
                    </DataTableCard>
                  ) : null}

                  {activeTab === 'health' ? (
                    <DataTableCard>
                      <DataTableCardHeader
                        title="采集健康度"
                        description="最近运行记录：区分「没取到」与「取到 0」"
                      />
                      <DataTableCardBody>
                        {selectedTargetId === null ? (
                          <EmptyState icon="database" message="请先在左侧选择一个追踪目标" className="py-16" />
                        ) : runsLoading ? (
                          <Skeleton className="h-[200px] w-full rounded-none" />
                        ) : (
                          <CrawlHealthPanel runs={runs} />
                        )}
                      </DataTableCardBody>
                    </DataTableCard>
                  ) : null}

                  {activeTab === 'external' ? (
                    <DataTableCard>
                      <DataTableCardHeader
                        title="外部竞品"
                        description="临时登记竞品 ASIN 并关联店铺；不影响 SKU 主数据"
                        action={
                          externalLoading ? (
                            <span className="font-mono text-[10px] text-term-muted">加载中…</span>
                          ) : null
                        }
                      />
                      <DataTableCardBody>
                        <ExternalTargetsPanel
                          targets={externalTargets}
                          shopOptions={shopOptions}
                          shopOptionsLoading={shopOptionsLoading}
                          isAdmin={isAdmin}
                          busy={writeBusy}
                          onCreate={handleCreateExternal}
                          onLink={handleLink}
                          onUnlink={handleUnlink}
                          onError={notifyWriteError}
                        />
                      </DataTableCardBody>
                    </DataTableCard>
                  ) : null}
                </TabsContent>
              </DirectionalTabTransition>
            </Tabs>
          </section>
        </div>
      </div>
    </>
  )
}
