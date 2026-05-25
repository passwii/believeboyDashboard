'use client'

import { useEffect, useState } from 'react'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'
import { fetchPeriodOverview, type InspectionOverview as InspectionOverviewType } from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { AlertTriangle, ChevronDown, ChevronUp, ImageIcon } from 'lucide-react'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'

interface InspectionOverviewProps {
  periodId: number
  refreshKey?: number
  onSelectProject: (projectId: number) => void
}

// AHR color styles
const AHR_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  Healthy: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-800' },
  Good: { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-700 dark:text-blue-400', border: 'border-blue-200 dark:border-blue-800' },
  'At Risk': { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-800' },
  Critical: { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-400', border: 'border-rose-200 dark:border-rose-800' },
}

// Status badge styles
const STATUS_STYLES: Record<string, { badge: string; label: string }> = {
  submitted: { badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400', label: '已提交' },
  draft: { badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400', label: '草稿' },
  overdue: { badge: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400', label: '已逾期' },
  pending: { badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', label: '待填写' },
}

// Anomaly thresholds
const THRESHOLDS = {
  odr: { warning: 0.5, critical: 1.0 },
  late_shipment_rate: { warning: 2, critical: 4 },
  valid_tracking_rate: { warning: 97, critical: 95, inverted: true },
  policy_violations: { warning: 1, critical: 3 },
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDatetime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDeadline(deadlineStr: string): { text: string; isOverdue: boolean } {
  const deadline = new Date(deadlineStr)
  const now = new Date()
  const isOverdue = now > deadline
  const text = deadline.toLocaleDateString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  return { text, isOverdue }
}

// ── Metric severity ──

type Severity = 'normal' | 'warning' | 'critical'

function getMetricSeverity(
  value: number | undefined | null,
  threshold: { warning: number; critical: number; inverted?: boolean } | undefined,
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
  warning: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-700 dark:text-amber-400' },
  critical: { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-700 dark:text-rose-400' },
}

// MetricBadge — renders a single metric with semantic color
interface MetricBadgeProps {
  label: string
  value: number | undefined | null
  unit?: string
  threshold?: { warning: number; critical: number; inverted?: boolean }
}

function MetricBadge({ label, value, unit = '%', threshold }: MetricBadgeProps) {
  if (value === undefined || value === null) {
    return (
      <div className="flex items-center justify-between rounded-md bg-[hsl(var(--surface-subtle))] px-2.5 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground/60">--</span>
      </div>
    )
  }

  const severity = getMetricSeverity(value, threshold)
  const styles = SEVERITY_STYLES[severity]

  return (
    <div className={`flex items-center justify-between rounded-md px-2.5 py-1.5 ${styles.bg || 'bg-[hsl(var(--surface-subtle))]'}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {severity !== 'normal' && (
          <AlertTriangle className={`h-3 w-3 ${styles.text}`} />
        )}
        <span className={`text-xs font-semibold ${styles.text}`}>
          {value}{unit}
        </span>
      </div>
    </div>
  )
}

// ── Collapsible notes ──

interface CollapsibleNotesProps {
  content: string | undefined
  maxLines?: number
}

function CollapsibleNotes({ content, maxLines = 2 }: CollapsibleNotesProps) {
  const [expanded, setExpanded] = useState(false)

  if (!content) {
    return (
      <p className="text-xs italic text-muted-foreground/50">暂无状态说明</p>
    )
  }

  const lineHeight = 20
  const maxHeight = maxLines * lineHeight

  return (
    <div className="relative">
      <div
        className="text-sm text-muted-foreground"
        style={{
          maxHeight: expanded ? 'none' : maxHeight,
          overflow: 'hidden',
        }}
      >
        {content}
      </div>
      {content.length > 100 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          className="mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {expanded ? (
            <><ChevronUp className="h-3 w-3" /> 收起</>
          ) : (
            <><ChevronDown className="h-3 w-3" /> 查看更多</>
          )}
        </button>
      )}
    </div>
  )
}

// ── Screenshot thumbnails ──

interface ScreenshotThumbnailsProps {
  screenshots: { id: number; url: string; thumbnail_url?: string; caption?: string }[]
  onPreview: (url: string) => void
}

function ScreenshotThumbnails({ screenshots, onPreview }: ScreenshotThumbnailsProps) {
  if (screenshots.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground/50">
        <ImageIcon className="h-3.5 w-3.5" />
        <span>暂无截图</span>
      </div>
    )
  }

  return (
    <div className="flex gap-2 overflow-x-auto">
      {screenshots.slice(0, 4).map((screenshot) => (
        <button
          key={screenshot.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onPreview(screenshot.url) }}
          className="relative h-16 w-24 flex-shrink-0 overflow-hidden rounded-md border border-border/70 transition-opacity hover:opacity-80"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screenshot.thumbnail_url || screenshot.url}
            alt={screenshot.caption || '截图'}
            className="h-full w-full object-cover"
          />
        </button>
      ))}
      {screenshots.length > 4 && (
        <div className="flex h-16 w-24 flex-shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50 text-xs text-muted-foreground">
          +{screenshots.length - 4}
        </div>
      )}
    </div>
  )
}

// ── ProjectCard: three-section layout ──

interface ProjectCardProps {
  item: InspectionOverviewType['items'][number]
  onClick: () => void
  onPreviewScreenshot: (url: string) => void
}

function ProjectCard({ item, onClick, onPreviewScreenshot }: ProjectCardProps) {
  const style = STATUS_STYLES[item.status] || STATUS_STYLES.pending
  const ahrStyle = item.account_health_rating
    ? AHR_STYLES[item.account_health_rating]
    : null

  return (
    <Card
      className="cursor-pointer border-border/70 transition-colors hover:border-primary/30"
      onClick={onClick}
    >
      {/* HEAD */}
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <span className="font-semibold text-foreground">{item.project_name}</span>
        <Badge className={style.badge}>{style.label}</Badge>
      </CardHeader>

      {/* BODY */}
      <CardContent className="space-y-3 pt-0">
        {/* AHR + ODR row */}
        <div className="flex flex-wrap items-center gap-2">
          {item.account_health_rating ? (
            <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${ahrStyle!.bg} ${ahrStyle!.border}`}>
              <span className="text-xs font-medium text-muted-foreground">AHR</span>
              <span className={`text-sm font-semibold ${ahrStyle!.text}`}>
                {item.account_health_rating}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2.5 py-1">
              <span className="text-xs text-muted-foreground/50">AHR --</span>
            </div>
          )}
          <MetricBadge
            label="ODR"
            value={item.odr}
            threshold={THRESHOLDS.odr}
          />
        </div>

        {/* Metrics grid */}
        <div className="grid grid-cols-2 gap-1.5">
          <MetricBadge
            label="迟发率"
            value={item.late_shipment_rate}
            threshold={THRESHOLDS.late_shipment_rate}
          />
          <MetricBadge
            label="有效追踪"
            value={item.valid_tracking_rate}
            threshold={THRESHOLDS.valid_tracking_rate}
          />
          <MetricBadge
            label="政策违规"
            value={item.policy_violations}
            unit=""
            threshold={THRESHOLDS.policy_violations}
          />
          {/* Deactivation risk */}
          <div className={`flex items-center justify-between rounded-md px-2.5 py-1.5 ${
            item.account_deactivation_risk === true
              ? 'bg-rose-50 dark:bg-rose-950/40'
              : 'bg-[hsl(var(--surface-subtle))]'
          }`}>
            <span className="text-xs text-muted-foreground">停用风险</span>
            {item.account_deactivation_risk === true ? (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-rose-600 dark:text-rose-400" />
                <span className="text-xs font-semibold text-rose-700 dark:text-rose-400">是</span>
              </div>
            ) : item.account_deactivation_risk === false ? (
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">否</span>
            ) : (
              <span className="text-xs text-muted-foreground/60">--</span>
            )}
          </div>
        </div>

        {/* Screenshots */}
        <ScreenshotThumbnails
          screenshots={item.screenshots || []}
          onPreview={onPreviewScreenshot}
        />

        {/* Status summary */}
        <CollapsibleNotes content={item.status_summary} />
      </CardContent>

      {/* FOOTER */}
      <CardFooter className="border-t border-border/50 pt-3">
        <p className="text-xs text-muted-foreground">
          {item.submitted_by ? (
            <>
              {item.submitted_by}
              {item.submitted_at && ` · ${formatDatetime(item.submitted_at)}`}
            </>
          ) : (
            <span className="italic text-muted-foreground/50">未提交</span>
          )}
        </p>
      </CardFooter>
    </Card>
  )
}

function ProjectCardSkeleton() {
  return (
    <Card className="border-border/70">
      <div className="space-y-3 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <div className="grid grid-cols-2 gap-1.5">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
          <Skeleton className="h-16 w-24" />
        </div>
        <Skeleton className="h-4 w-24" />
      </div>
    </Card>
  )
}

// ── Main overview component ──

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

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Header skeleton */}
        <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-4">
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

        {/* Grid skeleton */}
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
      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-8 text-center">
        <p className="text-muted-foreground">暂无巡检数据</p>
      </div>
    )
  }

  const { text: deadlineText, isOverdue } = formatDeadline(overview.period.deadline)
  const progressPercent = overview.total_projects > 0
    ? (overview.submitted_count / overview.total_projects) * 100
    : 0

  return (
    <>
      <div className="space-y-4">
        {/* Period header */}
        <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">
                {formatDate(overview.period.week_start)} - {formatDate(overview.period.week_end)}
              </h2>
              <p className="text-sm text-muted-foreground">
                截止时间: {deadlineText}
                {isOverdue && (
                  <span className="ml-2 text-rose-600 dark:text-rose-400">(已逾期)</span>
                )}
              </p>
            </div>
            <Badge className={isOverdue ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400' : ''}>
              {overview.submitted_count} / {overview.total_projects} 已提交
            </Badge>
          </div>

          {/* Progress bar */}
          <div className="mt-4 space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[hsl(var(--surface-subtle))]">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {overview.overdue_count > 0 && (
                <span className="text-rose-600 dark:text-rose-400">
                  {overview.overdue_count} 个项目已逾期
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Project grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {overview.items.map((item) => (
            <ProjectCard
              key={item.project_id}
              item={item}
              onClick={() => onSelectProject(item.project_id)}
              onPreviewScreenshot={setPreviewImage}
            />
          ))}
        </div>
      </div>

      {/* Image preview dialog */}
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
