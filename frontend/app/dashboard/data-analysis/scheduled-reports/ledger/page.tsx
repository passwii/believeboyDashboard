'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { format } from 'date-fns'
import Image from 'next/image'
import ReactMarkdown from 'react-markdown'
import {
  AlertTriangle, ChevronDown, Copy, ExternalLink, FileText, ImageIcon, Loader2, RotateCcw,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DateRangePicker, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { useNotifications } from '@/components/notifications'
import type { DateRange } from 'react-day-picker'
import type { Frequency, LedgerItem, ResendStage, Subscription } from '../_components/types'
import {
  fetchLedger,
  fetchModelConfig,
  fetchSubscriptions,
  pollDeliveryLogStatus,
  resendLedgerEntry,
} from '../_components/api'
import { LedgerResendCell } from '../_components/LedgerResendCell'
import type { AIModelConfig } from '../_components/types'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}
const FREQUENCY_COLORS: Record<Frequency, string> = {
  daily: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  weekly: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  monthly: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
}

const STATUS_LABELS: Record<string, string> = {
  sent: '成功',
  failed: '失败',
  missing: '缺失',
}
const STATUS_COLORS: Record<string, string> = {
  sent: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
  missing: 'text-amber-600 dark:text-amber-400',
}
const STATUS_BG: Record<string, string> = {
  sent: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  failed: 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  missing: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
}

export default function LedgerPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [previewScreenshotUrl, setPreviewScreenshotUrl] = useState<string | null>(null)
  const [previewSummary, setPreviewSummary] = useState<string | null>(null)
  const [resendingStates, setResendingStates] = useState<Record<string, ResendStage>>({})
  const [selectedItem, setSelectedItem] = useState<LedgerItem | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 30)

  const [ledgerStartDate, setLedgerStartDate] = useState(format(thirtyDaysAgo, 'yyyy-MM-dd'))
  const [ledgerEndDate, setLedgerEndDate] = useState(format(today, 'yyyy-MM-dd'))
  const [ledgerFrequency, setLedgerFrequency] = useState<string>('all')
  const [ledgerStatus, setLedgerStatus] = useState<string>('all')
  const [ledgerEmail, setLedgerEmail] = useState('')
  const initialLoadDone = useRef(false)

  const handleLedgerDateRangeChange = (range: DateRange | undefined) => {
    setLedgerStartDate(range?.from ? format(range.from, 'yyyy-MM-dd') : '')
    setLedgerEndDate(range?.to ? format(range.to, 'yyyy-MM-dd') : '')
  }

  const ledgerDateRangeValue = useMemo(
    () => parseDateRangeInputValue(ledgerStartDate, ledgerEndDate),
    [ledgerStartDate, ledgerEndDate],
  )

  useEffect(() => {
    setIsLoadingModelConfig(true)
    fetchModelConfig(
      (cfg) => { setModelConfig(cfg); setIsLoadingModelConfig(false) },
    )
  }, [])

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true)
    setLedgerError(null)
    await fetchLedger(
      {
        startDate: ledgerStartDate,
        endDate: ledgerEndDate,
        frequency: ledgerFrequency,
        statusFilter: ledgerStatus,
        email: ledgerEmail,
      },
      (items) => {
        setLedgerItems(items)
      },
      (error) => setLedgerError(error),
    )
    setLedgerLoading(false)
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus, ledgerEmail])

  useEffect(() => {
    void loadLedger()
    initialLoadDone.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!initialLoadDone.current) return
    void loadLedger()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus])

  useEffect(() => {
    if (!initialLoadDone.current) return
    const handle = setTimeout(() => void loadLedger(), 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerEmail])

  useEffect(() => {
    fetchSubscriptions(session, (subs) => setSubscriptions(subs))
  }, [session])

  const roleType = session?.user?.roleType
  const isAdmin = roleType === 'admin'
  const canTriggerResend = isAdmin

  const handleResendLedger = async (item: LedgerItem, overrideAiModel?: string | null) => {
    setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))
    const result = await resendLedgerEntry(item.ledger_key, isAdmin, overrideAiModel)
    if (result.ok && result.deliveryLogId) {
      pollDeliveryLogStatus(
        item.ledger_key,
        result.deliveryLogId,
        (key, stage) => setResendingStates(prev => ({ ...prev, [key]: stage as ResendStage })),
        async (key) => {
          await loadLedger()
          setTimeout(() => {
            setResendingStates(prev => {
              const next = { ...prev }
              delete next[key]
              return next
            })
          }, 1500)
        },
        (key) => {
          setResendingStates(prev => {
            const next = { ...prev }
            delete next[key]
            return next
          })
        },
      )
    } else if (!result.ok) {
      setResendingStates(prev => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      notify({ type: 'error', title: '操作失败', message: result.error || '未知错误' })
    } else {
      setResendingStates(prev => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      await loadLedger()
    }
  }

  const previewCopyText = useMemo(() => {
    if (!previewSummary) return ''
    return previewSummary.replace(/^[-•·●]\s*/gm, '◉ ')
  }, [previewSummary])

  const openDetailSheet = (item: LedgerItem) => {
    setSelectedItem(item)
    setSheetOpen(true)
  }

  return (
    <div className="space-y-3">
      {/* 工具栏 */}
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-4 space-y-4">
          <div className="hidden md:flex gap-3 flex-wrap items-center">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-9 w-[280px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none"
            />
            <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="频率" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部频率</SelectItem>
                <SelectItem value="daily">每日</SelectItem>
                <SelectItem value="weekly">每周</SelectItem>
                <SelectItem value="monthly">每月</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="sent">成功</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="missing">缺失</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="邮箱筛选"
              value={ledgerEmail}
              onChange={e => setLedgerEmail(e.target.value)}
              className="w-[200px] h-9"
            />
            <div className="ml-auto">
              <Button size="sm" onClick={loadLedger} disabled={ledgerLoading}>
                {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                刷新台账
              </Button>
            </div>
          </div>
          <div className="md:hidden space-y-2">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
                <SelectTrigger className="h-9"><SelectValue placeholder="频率" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="daily">每日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                  <SelectItem value="monthly">每月</SelectItem>
                </SelectContent>
              </Select>
              <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
                <SelectTrigger className="h-9"><SelectValue placeholder="状态" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="sent">成功</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                  <SelectItem value="missing">缺失</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input placeholder="邮箱筛选" value={ledgerEmail} onChange={e => setLedgerEmail(e.target.value)} className="h-9" />
            <Button size="sm" className="w-full" onClick={loadLedger} disabled={ledgerLoading}>
              {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
              刷新台账
            </Button>
          </div>

          {ledgerError && (
            <p className="mt-3 text-sm text-destructive">{ledgerError}</p>
          )}
        </CardContent>
      </Card>

      {/* 台账表格 */}
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-0">
          {/* 桌面端表格 */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>应发时间</TableHead>
                  <TableHead>频率</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12">
                      {ledgerLoading ? (
                        <div className="flex flex-col items-center gap-2">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">台账加载中...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <RotateCcw className="h-8 w-8 text-muted-foreground/30" />
                          <span className="text-sm text-muted-foreground">暂无台账记录</span>
                          <span className="text-xs text-muted-foreground/60">调整筛选条件或点击「刷新台账」</span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : ledgerItems.map(item => {
                  const sub = subscriptions.find(s => s.id === item.subscription_id)
                  const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
                  const canTrigger = canTriggerResend || item.can_resend

                  return (
                    <TableRow
                      key={item.ledger_key}
                      className="cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => openDetailSheet(item)}
                    >
                      <TableCell className="p-1" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => openDetailSheet(item)}
                          className="p-1 hover:bg-accent rounded transition-colors"
                        >
                          <ChevronDown className="h-4 w-4 text-muted-foreground -rotate-90" />
                        </button>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {new Date(item.expected_at).toLocaleString('zh-CN', {
                          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                        })}
                      </TableCell>
                      <TableCell>
                        <Badge className={cn('text-xs', FREQUENCY_COLORS[item.frequency])}>
                          {FREQUENCY_LABELS[item.frequency]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', STATUS_BG[item.status])}>
                          {item.status === 'sent' && '✓'}
                          {item.status === 'failed' && '✗'}
                          {item.status === 'missing' && <AlertTriangle className="h-3 w-3" />}
                          {STATUS_LABELS[item.status]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        {canTrigger ? (
                          <LedgerResendCell
                            item={item}
                            resendingStage={resendingStates[item.ledger_key]}
                            canResend
                            modelConfig={modelConfig}
                            isLoadingModelConfig={isLoadingModelConfig}
                            fallbackModel={fallbackModel}
                            onLoading={() => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
                            onSubmit={(overrideAiModel) => {
                              void handleResendLedger(item, overrideAiModel)
                            }}
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* 手机端卡片列表 */}
          <div className="md:hidden divide-y divide-border/60">
            {ledgerItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                {ledgerLoading ? (
                  <><Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-2" /><p className="text-sm text-muted-foreground">台账加载中...</p></>
                ) : (
                  <><RotateCcw className="h-8 w-8 text-muted-foreground/30 mb-2" /><p className="text-sm text-muted-foreground">暂无台账记录</p></>
                )}
              </div>
            ) : ledgerItems.map(item => {
              const projectLabel = item.project_names?.length ? item.project_names.join(', ') : item.project_ids
              const sub = subscriptions.find(s => s.id === item.subscription_id)
              const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
              const canTrigger = canTriggerResend || item.can_resend

              return (
                <div
                  key={item.ledger_key}
                  className="p-4 active:bg-accent/50 transition-colors"
                  onClick={() => openDetailSheet(item)}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {new Date(item.expected_at).toLocaleString('zh-CN')}
                      </div>
                      <div className="text-sm font-medium mt-0.5 truncate max-w-[180px]" title={projectLabel}>
                        {projectLabel}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge className={cn('text-xs', FREQUENCY_COLORS[item.frequency])}>
                        {FREQUENCY_LABELS[item.frequency]}
                      </Badge>
                      <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border', STATUS_BG[item.status])}>
                        {item.status === 'sent' ? '✓' : item.status === 'failed' ? '✗' : '⚠'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    {item.screenshot_r2_thumb_url && (
                      <button
                        type="button"
                        className="relative h-10 w-10 overflow-hidden rounded border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow shrink-0"
                        onClick={e => { e.stopPropagation(); setPreviewScreenshotUrl(item.screenshot_r2_url) }}
                      >
                        <Image src={item.screenshot_r2_thumb_url} alt="报告截图" fill className="object-cover" unoptimized />
                      </button>
                    )}
                    {item.ai_summary && (
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-[hsl(var(--chart-2))] text-[hsl(var(--chart-2))] hover:bg-[hsl(var(--chart-2))/10] transition-colors"
                        onClick={e => { e.stopPropagation(); setPreviewSummary(item.ai_summary) }}
                      >
                        <FileText className="h-3.5 w-3.5" />AI 文案
                      </button>
                    )}
                    <div className="ml-auto" onClick={e => e.stopPropagation()}>
                      {canTrigger ? (
                        <LedgerResendCell
                          item={item}
                          resendingStage={resendingStates[item.ledger_key]}
                          canResend
                          modelConfig={modelConfig}
                          isLoadingModelConfig={isLoadingModelConfig}
                          fallbackModel={fallbackModel}
                          onLoading={() => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
                          onSubmit={(overrideAiModel) => void handleResendLedger(item, overrideAiModel)}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── 台账详情 Sheet ── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-md w-full overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>台账详情</SheetTitle>
          </SheetHeader>
          {selectedItem && (() => {
            const sub = subscriptions.find(s => s.id === selectedItem.subscription_id)
            const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
            const canTrigger = canTriggerResend || selectedItem.can_resend
            const projectLabel = selectedItem.project_names?.length
              ? selectedItem.project_names.join(', ')
              : selectedItem.project_ids === '*' ? '全部项目' : selectedItem.project_ids
            return (
              <div className="space-y-5">
                {/* 状态横幅 */}
                <div className={cn(
                  'rounded-lg px-4 py-3 text-sm font-medium flex items-center gap-2 border',
                  STATUS_BG[selectedItem.status],
                )}>
                  {selectedItem.status === 'sent' && '✓ 发送成功'}
                  {selectedItem.status === 'failed' && '✗ 发送失败'}
                  {selectedItem.status === 'missing' && <><AlertTriangle className="h-4 w-4" /> 记录缺失</>}
                </div>

                {/* 基本信息 */}
                <div className="space-y-3 text-sm">
                  <InfoRow label="应发时间" value={new Date(selectedItem.expected_at).toLocaleString('zh-CN')} />
                  <InfoRow label="频率" value={FREQUENCY_LABELS[selectedItem.frequency]} />
                  <InfoRow label="项目" value={projectLabel} />
                  <div>
                    <span className="text-xs text-muted-foreground block mb-1">国家</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedItem.country.split(',').map(c => c.trim()).filter(Boolean).map(c => (
                        <Badge key={c} variant="secondary" className="text-xs">{getCountryLabel(c)}</Badge>
                      ))}
                    </div>
                  </div>
                  <InfoRow label="邮箱" value={selectedItem.email} />
                  {selectedItem.error_message && (
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1">错误信息</span>
                      <p className="text-xs text-destructive bg-destructive/5 rounded-md px-3 py-2 border border-destructive/20">
                        {selectedItem.error_message}
                      </p>
                    </div>
                  )}
                </div>

                {/* 截图 */}
                <div>
                  <span className="text-xs text-muted-foreground block mb-2">报告截图</span>
                  {selectedItem.screenshot_r2_url ? (
                    <button
                      type="button"
                      onClick={() => setPreviewScreenshotUrl(selectedItem.screenshot_r2_url)}
                      className="relative w-full aspect-[3/4] max-h-[300px] overflow-hidden rounded-lg border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow group"
                    >
                      <Image
                        src={selectedItem.screenshot_r2_thumb_url || selectedItem.screenshot_r2_url}
                        alt="报告截图"
                        fill
                        className="object-contain bg-muted/30"
                        unoptimized
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                        <ExternalLink className="h-6 w-6 text-white/0 group-hover:text-white/70 transition-colors" />
                      </div>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-4 border border-dashed border-border/50">
                      <ImageIcon className="h-4 w-4" />
                      暂无截图
                    </div>
                  )}
                </div>

                {/* AI 文案 */}
                <div>
                  <span className="text-xs text-muted-foreground block mb-2">AI 文案</span>
                  {selectedItem.ai_summary ? (
                    <div className="bg-muted/20 rounded-lg border border-border/50 overflow-hidden">
                      <div className="max-h-[200px] overflow-y-auto p-3 text-xs leading-relaxed
                        prose prose-xs prose-neutral dark:prose-invert max-w-none
                        [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold"
                      >
                        <ReactMarkdown>
                          {selectedItem.ai_summary.replace(/^[•·●]\s*/gm, '- ')}
                        </ReactMarkdown>
                      </div>
                      <div className="border-t border-border/50 px-3 py-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              selectedItem.ai_summary!.replace(/^[-•·●]\s*/gm, '◉ '),
                            )
                            notify({ type: 'success', title: '已复制' })
                          }}
                          className="flex items-center gap-1 text-xs text-[hsl(var(--chart-2))] hover:underline"
                        >
                          <Copy className="h-3 w-3" />
                          复制文案
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-4 border border-dashed border-border/50">
                      <FileText className="h-4 w-4" />
                      暂无 AI 文案
                    </div>
                  )}
                </div>

                {/* 重发操作 */}
                {canTrigger && (
                  <div className="pt-2 border-t border-border/60">
                    <span className="text-xs text-muted-foreground block mb-2">操作</span>
                    <LedgerResendCell
                      item={selectedItem}
                      resendingStage={resendingStates[selectedItem.ledger_key]}
                      canResend
                      modelConfig={modelConfig}
                      isLoadingModelConfig={isLoadingModelConfig}
                      fallbackModel={fallbackModel}
                      onLoading={() => setResendingStates(prev => ({ ...prev, [selectedItem.ledger_key]: 'preparing' }))}
                      onSubmit={(overrideAiModel) => {
                        void handleResendLedger(selectedItem, overrideAiModel)
                        setSheetOpen(false)
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })()}
        </SheetContent>
      </Sheet>

      {/* 截图预览弹窗 */}
      {previewScreenshotUrl && (
        <PortraitScreenshotDialog
          open
          onOpenChange={(open) => !open && setPreviewScreenshotUrl(null)}
          src={previewScreenshotUrl}
          alt="报告截图"
        />
      )}

      {/* AI 文案预览弹窗 */}
      {previewSummary ? (
        <Dialog open onOpenChange={() => setPreviewSummary(null)}>
          <DialogContent className="max-w-2xl sm:max-w-[540px] max-h-[80vh] flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
              <DialogTitle className="text-base font-semibold text-[hsl(var(--chart-2))]">报表总结</DialogTitle>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(previewCopyText)
                  setPreviewSummary(null)
                }}
                className="flex items-center justify-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[hsl(var(--chart-2))] text-white hover:opacity-90 transition-opacity w-full sm:w-auto"
              >
                <Copy className="h-4 w-4" />复制文案
              </button>
            </div>
            <div className="flex-1 overflow-y-auto text-sm text-foreground leading-relaxed
              prose prose-sm prose-neutral dark:prose-invert max-w-none
              prose-headings:text-base prose-p:text-sm prose-ul:text-sm prose-li:text-sm
              [&_ul]:my-1 [&_p]:my-1 [&_strong]:font-semibold [&_h2]:font-semibold [&_h2]:text-base"
            >
              <ReactMarkdown>{previewSummary.replace(/^[•·●]\s*/gm, '- ')}</ReactMarkdown>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

/** 文本信息行 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground block mb-0.5">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}
