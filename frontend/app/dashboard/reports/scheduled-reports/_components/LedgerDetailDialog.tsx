'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FileText,
  ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
} from 'lucide-react'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import { FREQUENCY_LABELS } from './ledger-constants'
import { fetchLedgerItemByKey } from './api'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'

// BLF-836 终端化：状态区去渐变，改扁平 term 语义色（pos/neg/warn）
const HERO_BG: Record<string, string> = {
  sent: 'bg-term-pos/10 border-term-pos/40',
  failed: 'bg-term-neg/10 border-term-neg/40',
  missing: 'bg-term-warn/10 border-term-warn/40',
}

const HERO_LABEL: Record<string, { text: string; color: string }> = {
  sent: { text: '✓ 发送成功', color: 'text-term-pos' },
  failed: { text: '✗ 发送失败', color: 'text-term-neg' },
  missing: { text: '⚠ 记录缺失', color: 'text-term-warn' },
}

const SECTION_LABEL =
  'font-mono text-[10px] uppercase tracking-wider text-term-muted mb-2 block'

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
  const [pollingState, setPollingState] = useState<
    'polling' | 'timed_out' | 'network_error' | 'idle'
  >('idle')
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  const failStreakRef = useRef<number>(0)
  const itemRef = useRef<LedgerItem | null>(item)
  const onItemRefreshedRef = useRef<typeof onItemRefreshed>(onItemRefreshed)
  useEffect(() => {
    itemRef.current = item
  }, [item])
  useEffect(() => {
    onItemRefreshedRef.current = onItemRefreshed
  }, [onItemRefreshed])

  const POLL_INTERVAL_MS = 2500
  const POLL_TIMEOUT_MS = 60_000
  const POLL_MAX_FAILS = 2

  const sub = item ? subscriptions.find((s) => s.id === item.subscription_id) : undefined
  const fallbackModel = item ? sub?.ai_model || modelConfig?.defaultModel || '' : ''
  const canTrigger = !!item && (canTriggerResend || item.can_resend)
  const canRegenerateSummary = !!item && canTriggerResend && item.status === 'sent'
  // BLF-822：后端改为周报/月报发送成功后不再自动生成 AI 摘要——`pending`
  // 语义从「排队/卡住」变为「尚未生成、等待手动触发」，只有 `generating`
  // 代表后台正在跑。补发等场景下 AI 摘要仍可能卡死在 generating（daemon
  // 被 kill 或后端重启），保留「打断并重新生成」作为卡死救援入口。
  const summaryGenerating =
    !regeneratingAiSummary && !!item && item.ai_summary_status === 'generating'
  const summaryActionLabel = regeneratingAiSummary
    ? '生成中…'
    : summaryGenerating
      ? '打断并重新生成'
      : item?.ai_summary
        ? '重新生成摘要'
        : '生成 AI 摘要'

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
    // BLF-822：仅 `generating` 需要轮询——`pending` 表示尚未生成、不会自行
    // 变化，轮询只会白等 60s 后误报「生成较慢」。
    const shouldPoll =
      open && !!item && !regeneratingAiSummary && item.ai_summary_status === 'generating'

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
  const countryList = !item
    ? []
    : item.country
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
  const visibleProjects = showAllProjects
    ? projectNames
    : projectNames.slice(0, MAX_VISIBLE_PROJECTS)
  const hiddenCount = projectNames.length - visibleProjects.length

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'max-w-[calc(100%-2rem)] rounded-none border-term-border bg-term-panel sm:max-w-xl md:max-w-3xl p-0 gap-0',
            'flex flex-col max-h-[calc(100vh-2rem)] overflow-hidden'
          )}
        >
          {item ? (
            <>
              <DialogHeader
                className={cn('shrink-0 border-b px-6 py-4 text-left', HERO_BG[item.status])}
              >
                <div className="flex items-center justify-between gap-2">
                  <div
                    className={cn(
                      'text-[11px] font-medium tracking-wide flex items-center gap-1.5',
                      HERO_LABEL[item.status].color
                    )}
                  >
                    {item.status === 'missing' && <AlertTriangle className="h-3 w-3" />}
                    {HERO_LABEL[item.status].text}
                  </div>
                  {canTriggerResend && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={handleManualRefresh}
                      disabled={manualRefreshing || item.ai_summary_status === 'generating'}
                      className="h-7 w-7 rounded-none text-term-muted hover:text-term-text"
                      aria-label="刷新 AI 摘要"
                      title="刷新 AI 摘要"
                    >
                      <RotateCcw
                        className={cn('h-3.5 w-3.5', manualRefreshing && 'animate-spin')}
                      />
                    </Button>
                  )}
                </div>
                <DialogTitle className="font-mono text-lg font-semibold tabular-nums tracking-tight text-term-text">
                  {format(new Date(item.expected_at), 'yyyy-MM-dd · HH:mm')}
                </DialogTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-term-muted">
                  <span>{item.email}</span>
                  <span>{FREQUENCY_LABELS[item.frequency]}</span>
                  {countryList.length > 0 && (
                    <span>{countryList.map(getCountryLabel).join(' · ')}</span>
                  )}
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {item.status === 'failed' && item.error_message && (
                  <div className="border border-term-neg/40 bg-term-neg/10 p-2">
                    <div className="mb-1 flex items-center gap-2 font-mono text-xs font-medium text-term-neg">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      错误信息
                    </div>
                    <div className="whitespace-pre-wrap font-mono text-xs text-term-neg">
                      {item.error_message}
                    </div>
                  </div>
                )}

                <div>
                  <span className={SECTION_LABEL}>报告范围</span>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-xs text-term-muted">
                    {visibleProjects.map((name, idx) => (
                      <span key={`${name}-${idx}`} className="border border-term-border bg-term-raised px-1.5 py-px">
                        {name}
                      </span>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(true)}
                        className="tabular-nums text-term-accent underline-offset-2 hover:underline"
                      >
                        +{hiddenCount} 更多
                      </button>
                    )}
                    {showAllProjects && projectNames.length > MAX_VISIBLE_PROJECTS && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(false)}
                        className="text-term-accent underline-offset-2 hover:underline"
                      >
                        收起
                      </button>
                    )}
                  </div>
                  {countryList.length > 0 && (
                    <div className="mt-2 font-mono text-xs tabular-nums text-term-muted">
                      {countryList.map(getCountryLabel).join(' · ')}
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
                        className="group relative aspect-[3/4] max-h-[60vh] w-full overflow-hidden rounded-none border border-term-border transition-colors hover:border-term-border-strong bg-term-raised"
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
                      <div className="flex min-h-[200px] items-center justify-center gap-2 rounded-none border border-dashed border-term-border bg-term-raised px-3 py-12 font-mono text-xs text-term-faint">
                        <ImageIcon className="h-4 w-4" aria-hidden />
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
                                disabled={regeneratingAiSummary || isLoadingModelConfig}
                                className="flex items-center gap-1 font-mono text-[11px] text-term-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                                aria-label={summaryActionLabel}
                              >
                                {regeneratingAiSummary ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : summaryGenerating ? (
                                  <Square className="h-3 w-3" />
                                ) : (
                                  <Sparkles className="h-3 w-3" />
                                )}
                                {summaryActionLabel}
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[280px] p-3" align="end">
                              <div className="space-y-2">
                                <div className="text-sm font-medium">{summaryActionLabel}</div>
                                <p className="text-xs text-muted-foreground">
                                  {summaryGenerating
                                    ? '后台生成似乎已卡住，会终止上一轮并启动新一轮 AI 摘要。不会重新截图或发送邮件。'
                                    : '只生成 AI 摘要，不会重新截图或发送邮件。'}
                                </p>
                                <div>
                                  <label className="text-xs font-medium mb-1 block text-muted-foreground">
                                    使用模型
                                  </label>
                                  <Select
                                    value={summaryModel}
                                    onValueChange={setSummaryModel}
                                    disabled={isLoadingModelConfig || !modelConfig?.models.length}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue
                                        placeholder={
                                          isLoadingModelConfig ? '加载模型中...' : '选择模型'
                                        }
                                      />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {fallbackModel && (
                                        <SelectItem value={fallbackModel}>
                                          <span className="flex items-center gap-1">
                                            <span className="text-muted-foreground">
                                              订阅预设：
                                            </span>
                                            <span>{fallbackModel}</span>
                                          </span>
                                        </SelectItem>
                                      )}
                                      {(modelConfig?.premiumModels.length || 0) > 0 && (
                                        <SelectGroup>
                                          <SelectLabel>高级模型</SelectLabel>
                                          {modelConfig?.premiumModels.map((m) => (
                                            <SelectItem key={m} value={m}>
                                              {m}
                                            </SelectItem>
                                          ))}
                                        </SelectGroup>
                                      )}
                                      {(modelConfig?.basicModels.length || 0) > 0 && (
                                        <SelectGroup>
                                          <SelectLabel>基础模型</SelectLabel>
                                          {modelConfig?.basicModels.map((m) => (
                                            <SelectItem key={m} value={m}>
                                              {m}
                                            </SelectItem>
                                          ))}
                                        </SelectGroup>
                                      )}
                                      {modelConfig?.models
                                        .filter(
                                          (m) =>
                                            !modelConfig.premiumModels.includes(m) &&
                                            !modelConfig.basicModels.includes(m) &&
                                            m !== fallbackModel
                                        )
                                        .map((m) => (
                                          <SelectItem key={m} value={m}>
                                            {m}
                                          </SelectItem>
                                        ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex gap-2 pt-1">
                                  <Button
                                    size="sm"
                                    className="flex-1"
                                    disabled={!summaryModel || regeneratingAiSummary}
                                    onClick={() => {
                                      setSummaryModelOpen(false)
                                      onRegenerateAiSummary(item, summaryModel)
                                    }}
                                  >
                                    {summaryGenerating ? '打断并重新生成' : '确认生成'}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="flex-1"
                                    onClick={() => setSummaryModelOpen(false)}
                                  >
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
                      <div className="max-h-[60vh] overflow-y-auto rounded-none border border-term-border bg-term-raised p-3 term-scroll">
                        <div className="text-xs leading-relaxed prose prose-xs prose-neutral dark:prose-invert max-w-none [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold">
                          <ReactMarkdown remarkPlugins={[remarkBreaks]}>
                            {item.ai_summary.replace(/^[•·●]\s*/gm, '- ')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : item.ai_summary_status === 'generating' || regeneratingAiSummary ? (
                      <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-none border border-term-accent/40 bg-term-accent/10 px-3 py-12 font-mono text-xs text-term-accent">
                        <div className="flex items-center gap-2">
                          {pollingState === 'timed_out' || pollingState === 'network_error' ? (
                            <AlertTriangle className="h-4 w-4" />
                          ) : (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          )}
                          <span>
                            {pollingState === 'timed_out' && 'AI 摘要生成较慢'}
                            {pollingState === 'network_error' && '网络异常，请重试'}
                            {(pollingState === 'polling' || pollingState === 'idle') &&
                              'AI 摘要生成中'}
                          </span>
                        </div>
                        {(pollingState === 'timed_out' || pollingState === 'network_error') &&
                          canTriggerResend && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                // 轮询超时 / 网络异常 → 一律走「打断并重新生成」，
                                // 单纯刷新数据已经无法救出卡死的后台线程。
                                setPollingState('idle')
                                onRegenerateAiSummary(item, fallbackModel || null)
                              }}
                              disabled={regeneratingAiSummary}
                              className="font-mono text-xs text-term-accent hover:bg-term-hover"
                            >
                              <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                              打断并重新生成
                            </Button>
                          )}
                      </div>
                    ) : item.ai_summary_status === 'pending' ? (
                      // BLF-822：pending = 报告已发送但摘要尚未生成（后端不再
                      // 自动生成），主行动是手动触发一次生成。
                      <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-none border border-dashed border-term-border bg-term-raised px-3 py-12 font-mono text-xs text-term-faint">
                        <Sparkles className="h-4 w-4 text-term-accent" aria-hidden />
                        <span>AI 摘要尚未生成</span>
                        {canRegenerateSummary && (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid="generate-summary-cta"
                            disabled={isLoadingModelConfig}
                            onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                            className="mt-1 font-mono text-xs text-term-accent hover:bg-term-hover"
                          >
                            <Sparkles className="mr-1 h-3 w-3" aria-hidden />
                            生成 AI 摘要
                          </Button>
                        )}
                      </div>
                    ) : item.ai_summary_status === 'failed' ? (
                      <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-none border border-term-neg/40 bg-term-neg/10 px-3 py-12 font-mono text-xs text-term-neg">
                        <AlertTriangle className="h-4 w-4" aria-hidden />
                        <span>AI 摘要生成失败</span>
                        {item.ai_summary_error && (
                          <span className="text-[11px] text-term-muted">
                            {item.ai_summary_error}
                          </span>
                        )}
                        {canRegenerateSummary && (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid="regenerate-summary-retry"
                            disabled={isLoadingModelConfig}
                            onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                            className="mt-1 font-mono text-xs text-term-neg hover:bg-term-hover"
                          >
                            <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                            重新生成
                          </Button>
                        )}
                      </div>
                    ) : (
                      <div className="flex min-h-[200px] items-center justify-center gap-2 rounded-none border border-dashed border-term-border bg-term-raised px-3 py-12 font-mono text-xs text-term-faint">
                        <FileText className="h-4 w-4" aria-hidden />
                        暂无 AI 文案
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {canTrigger && item && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-term-border bg-term-panel px-4 py-2.5">
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
          onOpenChange={(o) => !o && setPreviewScreenshot(null)}
          src={previewScreenshot}
          alt="报告截图"
        />
      )}
    </>
  )
}
