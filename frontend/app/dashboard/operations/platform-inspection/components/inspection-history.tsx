'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { StatusPill } from '@/components/ui/table-presets'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { useNotifications } from '@/components/notifications'
import {
  fetchInspectionHistory,
  fetchPeriods,
  fetchReport,
  type InspectionHistoryItem,
  type InspectionHistoryScreenshot,
  type InspectionReport,
  type InspectionPeriod,
} from '@/lib/inspection-api'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { Loader2, Eye, ImageIcon } from 'lucide-react'

interface InspectionHistoryProps {
  periodId: number
  /** 全局刷新计数：header 全局刷新时 bump，触发周期列表与历史记录重拉 */
  refreshKey?: number
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
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function HealthRatingBadge({ rating }: { rating: string }) {
  switch (rating.toLowerCase()) {
    case 'critical':
      return <StatusPill status="negative" label="危险" />
    case 'healthy':
      return <StatusPill status="success" label="健康" />
    default:
      return (
        <Badge variant="outline" className="text-xs">
          {rating}
        </Badge>
      )
  }
}

function DetailSheet({
  item,
  report,
  loading,
  open,
  onClose,
}: {
  item: InspectionHistoryItem | null
  report: InspectionReport | null
  loading: boolean
  open: boolean
  onClose: () => void
}) {
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{item?.project_name || '报告详情'}</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : report ? (
          <div className="mt-6 space-y-6">
            {/* Period info */}
            <div className="rounded-none border border-border/70 bg-term-raised p-4">
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">周期</span>
                  <span className="font-medium">
                    {item?.week_start} - {item?.week_end}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">状态</span>
                  <Badge className={STATUS_STYLES[item?.status || '']?.badge || ''}>
                    {STATUS_STYLES[item?.status || '']?.label || item?.status}
                  </Badge>
                </div>
                {item?.submitted_by && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">提交人</span>
                    <span>{item.submitted_by}</span>
                  </div>
                )}
                {item?.submitted_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">提交时间</span>
                    <span>{formatDateTime(item.submitted_at)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Health data */}
            {report.health_data && Object.keys(report.health_data).length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">账户健康指标</h3>
                <div className="rounded-none border border-border/70 bg-term-raised p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {report.health_data.account_health_rating && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">AHR</span>
                        <Badge variant="outline">{report.health_data.account_health_rating}</Badge>
                      </div>
                    )}
                    {report.health_data.negative_feedback !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">负面反馈</span>
                        <span>{report.health_data.negative_feedback}</span>
                      </div>
                    )}
                    {report.health_data.a2z_claims !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">亚马逊 A-to-Z</span>
                        <span>{report.health_data.a2z_claims}</span>
                      </div>
                    )}
                    {report.health_data.chargeback_claims !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">信用卡拒付</span>
                        <span>{report.health_data.chargeback_claims}</span>
                      </div>
                    )}
                    {report.health_data.late_shipment_rate !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">迟发率</span>
                        <span>{report.health_data.late_shipment_rate}%</span>
                      </div>
                    )}
                    {report.health_data.pre_fulfillment_cancel_rate !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">配送前取消率</span>
                        <span>{report.health_data.pre_fulfillment_cancel_rate}%</span>
                      </div>
                    )}
                    {report.health_data.valid_tracking_rate !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">有效追踪率</span>
                        <span>{report.health_data.valid_tracking_rate}%</span>
                      </div>
                    )}
                    {report.health_data.on_time_delivery_rate !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">准时交付率</span>
                        <span>{report.health_data.on_time_delivery_rate}%</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Compliance data */}
            {report.compliance_data && Object.keys(report.compliance_data).length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">政策与合规</h3>
                <div className="rounded-none border border-border/70 bg-term-raised p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {report.compliance_data.ip_infringement !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">涉嫌侵犯知识产权</span>
                        <span>{report.compliance_data.ip_infringement}</span>
                      </div>
                    )}
                    {report.compliance_data.ip_complaints !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">知识产权投诉</span>
                        <span>{report.compliance_data.ip_complaints}</span>
                      </div>
                    )}
                    {report.compliance_data.product_authenticity_complaints !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">商品真实性买家投诉</span>
                        <span>{report.compliance_data.product_authenticity_complaints}</span>
                      </div>
                    )}
                    {report.compliance_data.product_condition_complaints !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">商品状况买家投诉</span>
                        <span>{report.compliance_data.product_condition_complaints}</span>
                      </div>
                    )}
                    {report.compliance_data.food_product_safety !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">食品和商品安全问题</span>
                        <span>{report.compliance_data.food_product_safety}</span>
                      </div>
                    )}
                    {report.compliance_data.listing_policy_violations !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">上架政策违规</span>
                        <span>{report.compliance_data.listing_policy_violations}</span>
                      </div>
                    )}
                    {report.compliance_data.restricted_product_violations !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">违反受限商品政策</span>
                        <span>{report.compliance_data.restricted_product_violations}</span>
                      </div>
                    )}
                    {report.compliance_data.review_policy_violations !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">违反买家商品评论政策</span>
                        <span>{report.compliance_data.review_policy_violations}</span>
                      </div>
                    )}
                    {report.compliance_data.other_policy_violations !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">其他违反政策</span>
                        <span>{report.compliance_data.other_policy_violations}</span>
                      </div>
                    )}
                    {report.compliance_data.regulatory_compliance !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">监管合规性</span>
                        <span>{report.compliance_data.regulatory_compliance}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Status summary */}
            {report.status_summary && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">状态说明</h3>
                <div className="rounded-none border border-border/70 bg-term-raised p-4">
                  <p className="text-sm whitespace-pre-wrap">{report.status_summary}</p>
                </div>
              </div>
            )}

            {/* Screenshots */}
            {report.screenshots && report.screenshots.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">
                  截图 ({report.screenshots.length})
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  {report.screenshots.map((screenshot) => (
                    <div
                      key={screenshot.id}
                      className="space-y-2 rounded-none border border-border/70 bg-term-raised p-2"
                    >
                      <div
                        className="cursor-pointer overflow-hidden rounded"
                        onClick={() => setPreviewImage(screenshot.url)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={screenshot.url}
                          alt={screenshot.filename}
                          className="w-full object-contain"
                          style={{ maxHeight: '400px' }}
                        />
                      </div>
                      {screenshot.caption && (
                        <p className="text-xs text-muted-foreground">{screenshot.caption}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="py-8 text-center text-muted-foreground">暂无报告数据</p>
        )}
      </SheetContent>

      {previewImage && (
        <PortraitScreenshotDialog
          open={!!previewImage}
          onOpenChange={(open) => !open && setPreviewImage(null)}
          src={previewImage}
          alt="截图预览"
        />
      )}
    </Sheet>
  )
}

export default function InspectionHistory({ periodId, refreshKey }: InspectionHistoryProps) {
  const { notify } = useNotifications()
  const [history, setHistory] = useState<InspectionHistoryItem[]>([])
  const [periods, setPeriods] = useState<InspectionPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<number>(periodId)
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<InspectionHistoryItem | null>(null)
  const [detailReport, setDetailReport] = useState<InspectionReport | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [tablePreviewImage, setTablePreviewImage] = useState<string | null>(null)

  // Load periods for selector
  useEffect(() => {
    async function loadPeriods() {
      try {
        const data = await fetchPeriods(100)
        setPeriods(data.items)
      } catch (e) {
        console.error('Failed to load periods:', e)
      }
    }
    void loadPeriods()
  }, [refreshKey])

  // Load history when period changes
  useEffect(() => {
    async function loadHistory() {
      setLoading(true)
      try {
        const data = await fetchInspectionHistory({
          periodId: selectedPeriodId,
          limit: 100,
        })
        setHistory(data.items)
      } catch (e) {
        notify({
          type: 'error',
          title: '加载失败',
          message: normalizeErrorMessage(e, '获取历史记录失败'),
        })
      } finally {
        setLoading(false)
      }
    }
    void loadHistory()
  }, [selectedPeriodId, notify, refreshKey])

  const handleViewDetail = async (item: InspectionHistoryItem) => {
    setSelectedItem(item)
    setDetailReport(null)
    setDetailOpen(true)
    setDetailLoading(true)

    try {
      const report = await fetchReport(item.period_id, item.project_id)
      setDetailReport(report)
    } catch (e) {
      notify({
        type: 'error',
        title: '加载失败',
        message: normalizeErrorMessage(e, '获取报告详情失败'),
      })
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-muted-foreground">选择周期</label>
        <select
          value={selectedPeriodId}
          onChange={(e) => setSelectedPeriodId(Number(e.target.value))}
          className="h-9 min-h-[44px] flex-1 rounded-none border border-border/70 bg-term-panel px-3 text-sm sm:min-h-0 sm:flex-none"
        >
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {period.week_start} - {period.week_end}
            </option>
          ))}
        </select>
      </div>

      {/* History table */}
      <Card className="dashboard-surface animate-fade-slide-up">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <p className="py-12 text-center text-muted-foreground">暂无历史记录</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>AHR</TableHead>
                  <TableHead>合规问题</TableHead>
                  <TableHead>状态说明</TableHead>
                  <TableHead>截图</TableHead>
                  <TableHead>提交人</TableHead>
                  <TableHead>提交时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((item) => {
                  const style = STATUS_STYLES[item.status] || STATUS_STYLES.pending
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.project_name}</TableCell>
                      <TableCell>
                        <Badge className={style.badge}>{style.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {item.account_health_rating ? (
                          <HealthRatingBadge rating={item.account_health_rating} />
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell>
                        {item.compliance_total !== undefined && item.compliance_total !== null
                          ? item.compliance_total
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        {item.status_summary ? (
                          <span
                            className="line-clamp-2 text-sm text-foreground/90"
                            title={item.status_summary}
                          >
                            {item.status_summary}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {item.screenshots && item.screenshots.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {item.screenshots.slice(0, 4).map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                className="relative h-10 w-10 overflow-hidden rounded border border-border/70 transition-opacity hover:opacity-80"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setTablePreviewImage(s.url)
                                }}
                                title={s.caption || '查看截图'}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={s.thumbnail_url || s.url}
                                  alt={s.caption || '截图'}
                                  className="h-full w-full object-cover"
                                />
                              </button>
                            ))}
                            {item.screenshots.length > 4 && (
                              <div className="flex h-10 w-10 items-center justify-center rounded border border-border/70 text-xs text-muted-foreground">
                                +{item.screenshots.length - 4}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.submitted_by || '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(item.submitted_at)}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => handleViewDetail(item)}>
                          <Eye className="mr-1 h-4 w-4" />
                          查看
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Detail sheet */}
      <DetailSheet
        item={selectedItem}
        report={detailReport}
        loading={detailLoading}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          setSelectedItem(null)
        }}
      />

      {/* Table-level screenshot preview */}
      {tablePreviewImage && (
        <PortraitScreenshotDialog
          open={!!tablePreviewImage}
          onOpenChange={(open) => !open && setTablePreviewImage(null)}
          src={tablePreviewImage}
          alt="截图预览"
        />
      )}
    </div>
  )
}
