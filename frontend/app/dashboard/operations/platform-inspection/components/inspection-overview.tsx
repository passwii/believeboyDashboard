'use client'

import { useEffect, useState, useMemo, type CSSProperties } from 'react'
import { TermPanel } from '@/components/terminal/term-panel'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import {
  fetchPeriodOverview,
  type InspectionOverview as InspectionOverviewType,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { AlertTriangle, FileText, ImageIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { AhrRatingBadge, getAhrRatingPresentation } from './ahr-rating'

interface InspectionOverviewProps {
  periodId: number
  refreshKey?: number
  onSelectProject: (projectId: number) => void
}

const STATUS_STYLES: Record<string, { badge: string; label: string }> = {
  submitted: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
    label: '已提交',
  },
  draft: {
    badge: 'bg-term-warn/10 text-term-warn',
    label: '草稿',
  },
  overdue: {
    badge: 'bg-term-neg/10 text-term-neg',
    label: '已逾期',
  },
  pending: {
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    label: '待填写',
  },
}

const SHIPPING_THRESHOLDS = {
  late_shipment_rate: { warning: 2, critical: 4 },
  valid_tracking_rate: { warning: 97, critical: 95, inverted: true },
  on_time_delivery_rate: { warning: 97, critical: 95, inverted: true },
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDatetime(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDeadline(deadlineStr: string): { text: string; isOverdue: boolean } {
  const deadline = new Date(deadlineStr)
  const now = new Date()
  const isOverdue = now > deadline
  const text = deadline.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return { text, isOverdue }
}

type Severity = 'normal' | 'warning' | 'critical'

function getMetricSeverity(
  value: number | undefined | null,
  threshold: { warning: number; critical: number; inverted?: boolean } | undefined
): Severity {
  if (value === undefined || value === null || !threshold) return 'normal'
  if (threshold.inverted) {
    if (value <= threshold.critical) return 'critical'
    if (value <= threshold.warning) return 'warning'
    return 'normal'
  }
  if (value >= threshold.critical) return 'critical'
  if (value >= threshold.warning) return 'warning'
  return 'normal'
}

const SEVERITY_STYLES: Record<Severity, { bg: string; text: string }> = {
  normal: { bg: '', text: 'text-foreground' },
  warning: {
    bg: 'bg-term-warn/[0.07]',
    text: 'text-term-warn',
  },
  critical: {
    bg: 'bg-term-neg/[0.07]',
    text: 'text-term-neg',
  },
}

type CardSeverity = 'normal' | 'warning' | 'critical'

function getCardSeverity(item: InspectionOverviewType['items'][number]): CardSeverity {
  const ahrSeverity = getAhrRatingPresentation(item.account_health_rating).severity
  if (ahrSeverity === 'critical') return 'critical'
  if ((item.compliance_total ?? 0) >= 3) return 'critical'
  if (
    getMetricSeverity(item.late_shipment_rate, SHIPPING_THRESHOLDS.late_shipment_rate) ===
    'critical'
  )
    return 'critical'
  if (
    getMetricSeverity(item.valid_tracking_rate, SHIPPING_THRESHOLDS.valid_tracking_rate) ===
    'critical'
  )
    return 'critical'
  if (
    getMetricSeverity(item.on_time_delivery_rate, SHIPPING_THRESHOLDS.on_time_delivery_rate) ===
    'critical'
  )
    return 'critical'

  if (ahrSeverity === 'warning') return 'warning'
  if ((item.compliance_total ?? 0) >= 1) return 'warning'
  if (
    getMetricSeverity(item.late_shipment_rate, SHIPPING_THRESHOLDS.late_shipment_rate) === 'warning'
  )
    return 'warning'
  if (
    getMetricSeverity(item.valid_tracking_rate, SHIPPING_THRESHOLDS.valid_tracking_rate) ===
    'warning'
  )
    return 'warning'
  if (
    getMetricSeverity(item.on_time_delivery_rate, SHIPPING_THRESHOLDS.on_time_delivery_rate) ===
    'warning'
  )
    return 'warning'

  // 客户服务: any non-zero is a warning signal
  if (
    (item.negative_feedback ?? 0) > 0 ||
    (item.a2z_claims ?? 0) > 0 ||
    (item.chargeback_claims ?? 0) > 0
  )
    return 'warning'

  return 'normal'
}

const CARD_SEVERITY_STYLES: Record<CardSeverity, string> = {
  normal: '',
  warning:
    'border-[3px] border-term-warn/50 shadow-[0_0_0_1px_rgb(245_158_11_/_0.15)]',
  critical:
    'border-[3px] border-term-neg/50 shadow-[0_0_0_1px_rgb(244_63_94_/_0.18)]',
}

const SEVERITY_RANK: Record<CardSeverity, number> = {
  critical: 0,
  warning: 1,
  normal: 2,
}

interface MetricBadgeProps {
  label: string
  value: number | undefined | null
  unit?: string
  threshold?: { warning: number; critical: number; inverted?: boolean }
}

function MetricBadge({ label, value, unit = '%', threshold }: MetricBadgeProps) {
  if (value === undefined || value === null) {
    return (
      <div className="flex items-center justify-between rounded-none bg-term-raised px-2.5 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground/60">--</span>
      </div>
    )
  }

  const severity = getMetricSeverity(value, threshold)
  const styles = SEVERITY_STYLES[severity]

  return (
    <div
      className={`flex items-center justify-between rounded-none px-2.5 py-1.5 ${styles.bg || 'bg-term-raised'}`}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {severity !== 'normal' && <AlertTriangle className={`h-3 w-3 ${styles.text}`} />}
        <span className={`text-xs font-semibold ${styles.text}`}>
          {value}
          {unit}
        </span>
      </div>
    </div>
  )
}

function StatusSummaryIndicator({ content }: { content: string | null | undefined }) {
  if (!content) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="rounded-none p-1 text-muted-foreground transition-colors hover:bg-term-raised hover:text-foreground"
          aria-label="查看状态说明"
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-w-[280px] p-3 text-sm text-muted-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="whitespace-pre-wrap">{content}</p>
      </PopoverContent>
    </Popover>
  )
}

function ScreenshotCount({ count, onPreview }: { count: number; onPreview: () => void }) {
  if (count === 0) return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onPreview()
      }}
      className="inline-flex items-center gap-1 rounded-none bg-term-raised px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ImageIcon className="h-3 w-3" />
      {count}张截图
    </button>
  )
}

interface ProjectCardProps {
  item: InspectionOverviewType['items'][number]
  onClick: () => void
  onPreviewScreenshot: (url: string) => void
}

function ProjectCard({ item, onClick, onPreviewScreenshot }: ProjectCardProps) {
  const style = STATUS_STYLES[item.status] || STATUS_STYLES.pending
  const cardSeverity = getCardSeverity(item)
  const screenshotCount = item.screenshots?.length ?? 0
  const serviceTotal =
    (item.negative_feedback ?? 0) + (item.a2z_claims ?? 0) + (item.chargeback_claims ?? 0)

  return (
    <TermPanel
      title={item.project_name}
      actions={<Badge className={style.badge}>{style.label}</Badge>}
      className={`cursor-pointer transition-colors hover:bg-term-hover ${CARD_SEVERITY_STYLES[cardSeverity]}`}
      bodyClassName="space-y-3 p-3"
    >
      <button type="button" onClick={onClick} className="absolute inset-0 z-0" aria-label={`编辑 ${item.project_name}`} />
      <div className="relative z-10 space-y-3">
        {/* Section: 账号健康 + 客户服务 */}
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            账号健康
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {item.account_health_rating ? (
              <AhrRatingBadge rating={item.account_health_rating} showCode />
            ) : (
              <div className="flex items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2.5 py-1">
                <span className="text-xs text-muted-foreground/50">AHR --</span>
              </div>
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${ serviceTotal > 0 ? 'border-term-warn/30 bg-term-warn/[0.07] dark:bg-term-warn/10' : 'border-border/70 bg-term-raised' }`}
            >
              <span className="text-xs text-muted-foreground">客服</span>
              {serviceTotal > 0 ? (
                <span className="text-xs font-semibold text-term-warn">
                  {serviceTotal}
                </span>
              ) : (
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  0
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Section: 配送绩效 + 合规 */}
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            配送 &amp; 合规
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <MetricBadge
              label="迟发率"
              value={item.late_shipment_rate}
              threshold={SHIPPING_THRESHOLDS.late_shipment_rate}
            />
            <MetricBadge
              label="有效追踪"
              value={item.valid_tracking_rate}
              threshold={SHIPPING_THRESHOLDS.valid_tracking_rate}
            />
            <MetricBadge
              label="准时交付"
              value={item.on_time_delivery_rate}
              threshold={SHIPPING_THRESHOLDS.on_time_delivery_rate}
            />
            <div
              className={`flex items-center justify-between rounded-none px-2.5 py-1.5 ${ (item.compliance_total ?? 0) >= 3 ? 'bg-term-neg/[0.07] dark:bg-term-neg/10' : (item.compliance_total ?? 0) >= 1 ? 'bg-term-warn/[0.07] dark:bg-term-warn/10' : 'bg-term-raised' }`}
            >
              <span className="text-xs text-muted-foreground">合规问题</span>
              {(item.compliance_total ?? 0) > 0 ? (
                <div className="flex items-center gap-1">
                  <AlertTriangle
                    className={`h-3 w-3 ${ (item.compliance_total ?? 0) >= 3 ? 'text-term-neg dark:text-term-neg' : 'text-term-warn dark:text-term-warn' }`}
                  />
                  <span
                    className={`text-xs font-semibold ${ (item.compliance_total ?? 0) >= 3 ? 'text-term-neg dark:text-term-neg' : 'text-term-warn dark:text-term-warn' }`}
                  >
                    {item.compliance_total}
                  </span>
                </div>
              ) : item.compliance_total !== undefined && item.compliance_total !== null ? (
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  0
                </span>
              ) : (
                <span className="text-xs text-muted-foreground/60">--</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 flex items-center justify-between border-t border-term-border px-3 py-2">
        <p className="font-mono text-[11px] text-term-muted">
          {item.submitted_by ? (
            <>
              {item.submitted_by}
              {item.submitted_at && ` · ${formatDatetime(item.submitted_at)}`}
            </>
          ) : (
            <span className="italic text-term-faint">未提交</span>
          )}
        </p>
        <div className="flex items-center gap-1">
          <ScreenshotCount
            count={screenshotCount}
            onPreview={() => {
              const first = item.screenshots?.[0]
              const firstUrl =
                typeof first === 'object' &&
                first !== null &&
                'url' in first &&
                typeof (first as { url: unknown }).url === 'string'
                  ? (first as { url: string }).url
                  : undefined
              if (firstUrl) onPreviewScreenshot(firstUrl)
            }}
          />
          <StatusSummaryIndicator content={item.status_summary} />
        </div>
      </div>
    </TermPanel>
  )
}

function ProjectCardSkeleton() {
  return (
    <TermPanel bodyClassName="space-y-3 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-3 w-12" />
      <div className="grid grid-cols-2 gap-1.5">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
      <div className="flex items-center justify-between border-t border-term-border pt-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-5 w-14" />
      </div>
    </TermPanel>
  )
}

export default function InspectionOverview({
  periodId,
  onSelectProject,
  refreshKey,
}: InspectionOverviewProps) {
  const { notify } = useNotifications()
  const [overview, setOverview] = useState<InspectionOverviewType | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  useEffect(() => {
    async function loadOverview() {
      setLoading(true)
      try {
        const data = await fetchPeriodOverview(periodId)
        setOverview(data)
      } catch (e) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(e, '获取巡检概览失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadOverview()
  }, [periodId, refreshKey, notify])

  const sortedItems = useMemo(() => {
    if (!overview) return []
    return [...overview.items].sort(
      (a, b) => SEVERITY_RANK[getCardSeverity(a)] - SEVERITY_RANK[getCardSeverity(b)]
    )
  }, [overview])

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-none border border-border/70 bg-term-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-6 w-24" />
          </div>
          <div className="mt-4 space-y-2">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="rounded-none border border-border/70 bg-term-panel p-8 text-center">
        <p className="text-muted-foreground">暂无巡检数据</p>
      </div>
    )
  }

  const { text: deadlineText, isOverdue } = formatDeadline(overview.period.deadline)
  const progressPercent =
    overview.total_projects > 0 ? (overview.submitted_count / overview.total_projects) * 100 : 0
  const warningCount = overview.items.filter((i) => getCardSeverity(i) === 'warning').length
  const criticalCount = overview.items.filter((i) => getCardSeverity(i) === 'critical').length
  const hasAlerts = overview.overdue_count > 0 || criticalCount > 0 || warningCount > 0

  return (
    <>
      <div className="space-y-4">
        <div
          className={cn(
            'dashboard-surface p-5',
            isOverdue && 'border-t-[3px] border-t-rose-500 dark:border-t-rose-400'
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">
                {formatDate(overview.period.week_start)} - {formatDate(overview.period.week_end)}
              </h2>
              <p className="text-sm text-muted-foreground">
                截止时间: {deadlineText}
                {isOverdue && (
                  <span className="ml-2 text-term-neg">(已逾期)</span>
                )}
              </p>
            </div>
            <Badge
              className={
                isOverdue ? 'bg-term-neg/10 text-term-neg' : ''
              }
            >
              {overview.submitted_count} / {overview.total_projects} 已提交
            </Badge>
          </div>

          <div className="mt-4 space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-term-raised">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>

        {hasAlerts && (
          <div className="flex items-center gap-3 rounded-none border border-term-warn/20 bg-term-warn/[0.05] px-4 py-2.5[0.06]">
            <AlertTriangle className="h-4 w-4 shrink-0 text-term-warn" />
            <p className="text-sm">
              {overview.overdue_count > 0 && (
                <span className="text-term-warn">
                  {overview.overdue_count} 个项目已逾期
                </span>
              )}
              {overview.overdue_count > 0 && criticalCount > 0 && (
                <span className="mx-1.5 text-muted-foreground">·</span>
              )}
              {criticalCount > 0 && (
                <span className="font-medium text-term-neg">
                  {criticalCount} 个项目严重异常
                </span>
              )}
              {criticalCount > 0 && warningCount > 0 && (
                <span className="mx-1.5 text-muted-foreground">·</span>
              )}
              {warningCount > 0 && (
                <span className="text-term-warn">
                  {warningCount} 个项目存在风险
                </span>
              )}
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedItems.map((item, index) => (
            <div
              key={item.project_id}
              className="u-stagger-item"
              style={{ '--i': index } as CSSProperties}
            >
              <ProjectCard
                item={item}
                onClick={() => onSelectProject(item.project_id)}
                onPreviewScreenshot={setPreviewImage}
              />
            </div>
          ))}
        </div>
      </div>

      {previewImage && (
        <PortraitScreenshotDialog
          open={!!previewImage}
          onOpenChange={(open) => !open && setPreviewImage(null)}
          src={previewImage}
          alt="巡检截图预览"
        />
      )}
    </>
  )
}
