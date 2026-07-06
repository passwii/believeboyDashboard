'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { AlertTriangle, Copy, ExternalLink, FileText, ImageIcon, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import { FREQUENCY_LABELS } from './ledger-constants'
import { fetchLedgerItemByKey } from './api'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'

const HERO_BG: Record<string, string> = {
  sent: 'bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-background border-emerald-200 dark:border-emerald-800',
  failed: 'bg-gradient-to-br from-red-50 to-white dark:from-red-950/30 dark:to-background border-red-200 dark:border-red-800',
  missing: 'bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/30 dark:to-background border-amber-200 dark:border-amber-800',
}

const HERO_LABEL: Record<string, { text: string; color: string }> = {
  sent: { text: '✓ 发送成功', color: 'text-emerald-700 dark:text-emerald-300' },
  failed: { text: '✗ 发送失败', color: 'text-red-700 dark:text-red-300' },
  missing: { text: '⚠ 记录缺失', color: 'text-amber-700 dark:text-amber-300' },
}

const SECTION_LABEL = 'text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2 block'

const MAX_VISIBLE_PROJECTS = 8

interface LedgerDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: LedgerItem | null
  subscriptions: Subscription[]
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  resendingStage: ResendStage | undefined
  regeneratingAiSummary: boolean
  canTriggerResend: boolean
  onResend: (item: LedgerItem, overrideAiModel: string | null) => void
  onResendLoading: (item: LedgerItem) => void
  onRegenerateAiSummary: (item: LedgerItem, overrideAiModel: string | null) => void
  onCopy: (text: string) => void
  onItemRefreshed?: (item: LedgerItem) => void
}

export function LedgerDetailDialog({
  open,
  onOpenChange,
  item,
  subscriptions,
  modelConfig,
  isLoadingModelConfig,
  resendingStage,
  regeneratingAiSummary,
  canTriggerResend,
  onResend,
  onResendLoading,
  onRegenerateAiSummary,
  onCopy,
  onItemRefreshed,
}: LedgerDetailDialogProps) {
  const [previewScreenshot, setPreviewScreenshot] = useState<string | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [summaryModelOpen, setSummaryModelOpen] = useState(false)
  const [summaryModel, setSummaryModel] = useState('')
  const [pollingState, setPollingState] = useState<'polling' | 'timed_out' | 'network_error' | 'idle'>('idle')
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  const failStreakRef = useRef<number>(0)
  const itemRef = useRef<LedgerItem | null>(item)
  const onItemRefreshedRef = useRef<typeof onItemRefreshed>(onItemRefreshed)
  useEffect(() => { itemRef.current = item }, [item])
  useEffect(() => { onItemRefreshedRef.current = onItemRefreshed }, [onItemRefreshed])

  const POLL_INTERVAL_MS = 2500
  const POLL_TIMEOUT_MS = 60_000
  const POLL_MAX_FAILS = 2

  const sub = item ? subscriptions.find(s => s.id === item.subscription_id) : undefined
  const fallbackModel = item ? (sub?.ai_model || modelConfig?.defaultModel || '') : ''
  const canTrigger = !!item && (canTriggerResend || item.can_resend)
  const canRegenerateSummary = !!item && canTriggerResend && item.status === 'sent'
  const summaryActionLabel = item?.ai_summary ? '重新生成摘要' : '补充 AI 摘要'

  useEffect(() => {
    if (summaryModelOpen) setSummaryModel(fallbackModel)
  }, [summaryModelOpen, fallbackModel])

  const handleManualRefresh = async () => {
    if (!item) return
    setManualRefreshing(true)
    try {
      const fresh = await fetchLedgerItemByKey(item)
      if (fresh) {
        onItemRefreshed?.(fresh)
        setPollingState('idle')
      }
    } catch {
      // 静默；用户可在 header 再次点击重试
    } finally {
      setManualRefreshing(false)
    }
  }

  useEffect(() => {
    const shouldPoll =
      open
      && !!item
      && !regeneratingAiSummary
      && (item.ai_summary_status === 'pending' || item.ai_summary_status === 'generating')

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (!shouldPoll) {
      setPollingState('idle')
      return
    }

    startedAtRef.current = Date.now()
    failStreakRef.current = 0
    setPollingState('polling')

    const tick = async () => {
      if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        intervalRef.current = null
        setPollingState('timed_out')
        return
      }
      const current = itemRef.current
      if (!current) return
      try {
        const fresh = await fetchLedgerItemByKey(current)
        failStreakRef.current = 0
        if (fresh) {
          onItemRefreshedRef.current?.(fresh)
          if (fresh.ai_summary_status === 'done' || fresh.ai_summary_status === 'failed') {
            if (intervalRef.current) clearInterval(intervalRef.current)
            intervalRef.current = null
            setPollingState('idle')
          }
        }
      } catch {
        failStreakRef.current += 1
        if (failStreakRef.current >= POLL_MAX_FAILS) {
          if (intervalRef.current) clearInterval(intervalRef.current)
          intervalRef.current = null
          setPollingState('network_error')
        }
      }
    }

    intervalRef.current = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    // 依赖项只用原始字段（避免父组件 selectedItem 引用变化导致 effect 反复重启）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.ledger_key, item?.ai_summary_status, regeneratingAiSummary])

  const projectNames = !item
    ? []
    : item.project_names?.length > 0
      ? item.project_names
      : item.project_ids === '*'
        ? ['全部项目']
        : item.project_ids.split(',').filter(Boolean)
  const countryList = !item ? [] : item.country.split(',').map(c => c.trim()).filter(Boolean)
  const visibleProjects = showAllProjects ? projectNames : projectNames.slice(0, MAX_VISIBLE_PROJECTS)
  const hiddenCount = projectNames.length - visibleProjects.length

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'max-w-[calc(100%-2rem)] sm:max-w-xl md:max-w-3xl p-0 gap-0',
            'flex flex-col max-h-[calc(100vh-2rem)] overflow-hidden',
            'dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]',
          )}
        >
          {item ? (
            <>
              <DialogHeader
                className={cn(
                  'shrink-0 border-b px-6 py-4 text-left',
                  HERO_BG[item.status],
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className={cn('text-[11px] font-medium tracking-wide flex items-center gap-1.5', HERO_LABEL[item.status].color)}>
                    {item.status === 'missing' && <AlertTriangle className="h-3 w-3" />}
                    {HERO_LABEL[item.status].text}
                  </div>
                  {canTriggerResend && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={handleManualRefresh}
                      disabled={manualRefreshing || item.ai_summary_status === 'generating'}
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      aria-label="刷新 AI 摘要"
                      title="刷新 AI 摘要"
                    >
                      <RotateCcw className={cn('h-3.5 w-3.5', manualRefreshing && 'animate-spin')} />
                    </Button>
                  )}
                </div>
                <DialogTitle className="text-xl font-semibold tracking-tight">
                  {format(new Date(item.expected_at), 'yyyy-MM-dd · HH:mm')}
                </DialogTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>📨 {item.email}</span>
                  <span>{FREQUENCY_LABELS[item.frequency]}</span>
                  {countryList.length > 0 && <span>{countryList.map(getCountryLabel).join(' · ')}</span>}
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {item.status === 'failed' && item.error_message && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:bg-red-950/30 dark:border-red-800">
                    <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300 mb-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      错误信息
                    </div>
                    <div className="font-mono text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">
                      {item.error_message}
                    </div>
                  </div>
                )}

                <div>
                  <span className={SECTION_LABEL}>报告范围</span>
                  <div className="flex flex-wrap gap-1.5">
                    {visibleProjects.map((name, idx) => (
                      <Badge
                        key={`${name}-${idx}`}
                        variant="secondary"
                        className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50 text-[11px] dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                      >
                        {name}
                      </Badge>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(true)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        +{hiddenCount} 更多
                      </button>
                    )}
                    {showAllProjects && projectNames.length > MAX_VISIBLE_PROJECTS && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(false)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        收起
                      </button>
                    )}
                  </div>
                  {countryList.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {countryList.map(c => (
                        <Badge key={c} variant="outline" className="text-[11px]">
                          {getCountryLabel(c)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <span className={SECTION_LABEL}>报告截图</span>
                    {item.screenshot_r2_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewScreenshot(item.screenshot_r2_url)}
                        className="group relative w-full aspect-[3/4] max-h-[60vh] overflow-hidden rounded-lg border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow bg-muted/30"
                      >
                        <Image
                          src={item.screenshot_r2_thumb_url || item.screenshot_r2_url}
                          alt="报告截图"
                          fill
                          className="object-contain"
                          unoptimized
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                          <ExternalLink className="h-5 w-5 text-white/0 group-hover:text-white/70 transition-colors" />
                        </div>
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-12 border border-dashed border-border/50 justify-center min-h-[200px]">
                        <ImageIcon className="h-4 w-4" />
                        暂无截图
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className={cn(SECTION_LABEL, 'mb-0')}>AI 文案</span>
                      <div className="flex items-center gap-2">
                        {canRegenerateSummary && (
                          <Popover open={summaryModelOpen} onOpenChange={setSummaryModelOpen}>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                disabled={regeneratingAiSummary || item.ai_summary_status === 'generating' || isLoadingModelConfig}
                                className="flex items-center gap-1 text-[11px] text-violet-600 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:text-violet-400"
                                aria-label={summaryActionLabel}
                              >
                                {regeneratingAiSummary || item.ai_summary_status === 'generating' ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Sparkles className="h-3 w-3" />
                                )}
                                {regeneratingAiSummary || item.ai_summary_status === 'generating' ? '生成中' : summaryActionLabel}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[280px] p-3" align="end">
                              <div className="space-y-2">
                                <div className="text-sm font-medium">{summaryActionLabel}</div>
                                <p className="text-xs text-muted-foreground">
                                  只重新生成 AI 摘要，不会重新截图或发送邮件。
                                </p>
                                <div>
                                  <label className="text-xs font-medium mb-1 block text-muted-foreground">使用模型</label>
                                  <Select
                                    value={summaryModel}
                                    onValueChange={setSummaryModel}
                                    disabled={isLoadingModelConfig || !modelConfig?.models.length}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {fallbackModel && (
                                        <SelectItem value={fallbackModel}>
                                          <span className="flex items-center gap-1">
                                            <span className="text-muted-foreground">订阅预设：</span>
                                            <span>{fallbackModel}</span>
                                          </span>
                                        </SelectItem>
                                      )}
                                      {(modelConfig?.premiumModels.length || 0) > 0 && (
                                        <SelectGroup>
                                          <SelectLabel>高级模型</SelectLabel>
                                          {modelConfig?.premiumModels.map(m => (
                                            <SelectItem key={m} value={m}>{m}</SelectItem>
                                          ))}
                                        </SelectGroup>
                                      )}
                                      {(modelConfig?.basicModels.length || 0) > 0 && (
                                        <SelectGroup>
                                          <SelectLabel>基础模型</SelectLabel>
                                          {modelConfig?.basicModels.map(m => (
                                            <SelectItem key={m} value={m}>{m}</SelectItem>
                                          ))}
                                        </SelectGroup>
                                      )}
                                      {modelConfig?.models
                                        .filter(m => !modelConfig.premiumModels.includes(m) && !modelConfig.basicModels.includes(m) && m !== fallbackModel)
                                        .map(m => (
                                          <SelectItem key={m} value={m}>{m}</SelectItem>
                                        ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex gap-2 pt-1">
                                  <Button
                                    size="sm"
                                    className="flex-1"
                                    disabled={!summaryModel || regeneratingAiSummary || item.ai_summary_status === 'generating'}
                                    onClick={() => {
                                      setSummaryModelOpen(false)
                                      onRegenerateAiSummary(item, summaryModel)
                                    }}
                                  >
                                    确认生成
                                  </Button>
                                  <Button size="sm" variant="ghost" className="flex-1" onClick={() => setSummaryModelOpen(false)}>
                                    取消
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                        {item.ai_summary && (
                          <button
                            type="button"
                            onClick={() => onCopy(item.ai_summary!.replace(/^[-•·●]\s*/gm, '◉ '))}
                            className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                            aria-label="复制 AI 文案"
                          >
                            <Copy className="h-3 w-3" />
                            复制
                          </button>
                        )}
                      </div>
                    </div>
                    {item.ai_summary ? (
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-3 max-h-[60vh] overflow-y-auto">
                        <div className="text-xs leading-relaxed prose prose-xs prose-neutral dark:prose-invert max-w-none [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold">
                          <ReactMarkdown>
                            {item.ai_summary.replace(/^[•·●]\s*/gm, '- ')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : item.ai_summary_status === 'generating' || item.ai_summary_status === 'pending' || regeneratingAiSummary ? (
                      <div className="flex flex-col items-center gap-2 text-xs text-violet-600 bg-violet-50 rounded-lg px-3 py-12 border border-violet-100 justify-center min-h-[200px] dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-900">
                        <div className="flex items-center gap-2">
                          {pollingState === 'timed_out' || pollingState === 'network_error' ? (
                            <AlertTriangle className="h-4 w-4" />
                          ) : (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          )}
                          <span>
                            {pollingState === 'timed_out' && 'AI 摘要生成较慢'}
                            {pollingState === 'network_error' && '网络异常，请重试'}
                            {(pollingState === 'polling' || pollingState === 'idle') && 'AI 摘要生成中'}
                          </span>
                        </div>
                        {(pollingState === 'timed_out' || pollingState === 'network_error') && canTriggerResend && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleManualRefresh}
                            disabled={manualRefreshing}
                            className="text-violet-700 dark:text-violet-300"
                          >
                            <RotateCcw className={cn('mr-1 h-3 w-3', manualRefreshing && 'animate-spin')} />
                            立即刷新
                          </Button>
                        )}
                      </div>
                    ) : item.ai_summary_status === 'failed' ? (
                      <div className="flex flex-col items-center gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-12 border border-red-100 justify-center min-h-[200px] dark:bg-red-950/30 dark:text-red-300 dark:border-red-900">
                        <AlertTriangle className="h-4 w-4" />
                        <span>AI 摘要生成失败，可点击上方按钮重试</span>
                        {item.ai_summary_error && <span className="text-[11px] text-muted-foreground">{item.ai_summary_error}</span>}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-12 border border-dashed border-border/50 justify-center min-h-[200px]">
                        <FileText className="h-4 w-4" />
                        暂无 AI 文案
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {canTrigger && item && (
            <div className="shrink-0 border-t border-border/60 bg-background px-6 py-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <LedgerResendCell
                item={item}
                resendingStage={resendingStage}
                canResend
                modelConfig={modelConfig}
                isLoadingModelConfig={isLoadingModelConfig}
                fallbackModel={fallbackModel}
                onLoading={() => onResendLoading(item)}
                onSubmit={(overrideAiModel) => {
                  onResend(item, overrideAiModel)
                  onOpenChange(false)
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {previewScreenshot && (
        <PortraitScreenshotDialog
          open
          onOpenChange={o => !o && setPreviewScreenshot(null)}
          src={previewScreenshot}
          alt="报告截图"
        />
      )}
    </>
  )
}