'use client'

import { useEffect, useState } from 'react'
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { InsightStreamPanel } from '@/components/insight/insight-stream-panel'
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
import { ledgerCopyText } from './ledger-insight'
import { useLedgerInsight } from './use-ledger-insight'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'
import styles from '../scheduled-reports-warm.module.css'

// 状态区沿用真实发送状态与 Warm 语义色，不额外引入说明文案。
const HERO_BG: Record<string, string> = {
  sent: 'bg-[color-mix(in_srgb,var(--warm-ledger-color-positive)_10%,transparent)] border-[color:color-mix(in_srgb,var(--warm-ledger-color-positive)_40%,transparent)]',
  failed: 'bg-[color-mix(in_srgb,var(--warm-ledger-color-negative)_10%,transparent)] border-[color:color-mix(in_srgb,var(--warm-ledger-color-negative)_40%,transparent)]',
  missing: 'bg-[var(--warm-ledger-color-accent-soft)] border-[color:color-mix(in_srgb,var(--warm-ledger-color-accent)_40%,transparent)]',
}

const HERO_LABEL: Record<string, { text: string; color: string }> = {
  sent: { text: '✓ 发送成功', color: 'text-[color:var(--warm-ledger-color-positive)]' },
  failed: { text: '✗ 发送失败', color: 'text-[color:var(--warm-ledger-color-negative)]' },
  missing: { text: '⚠ 记录缺失', color: 'text-[color:var(--warm-ledger-color-accent)]' },
}

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
  const [manualRefreshing, setManualRefreshing] = useState(false)

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
  // BLF-1015：`generating` 且有既存摘要时，详情已能看到后台进度，入口只负责
  // 「另起一轮」；没有既存摘要才需要「打断并重新生成」这样的卡死救援语义。
  const summaryInterrupt = !item?.ai_summary && summaryGenerating
  const summaryActionLabel = regeneratingAiSummary
    ? '生成中…'
    : summaryInterrupt
      ? '打断并重新生成'
      : item?.ai_summary
        ? '重新生成摘要'
        : '生成 AI 摘要'

  const { panel, runBound } = useLedgerInsight({
    open,
    item,
    regenerating: regeneratingAiSummary,
    onItemRefreshed,
  })

  useEffect(() => {
    if (summaryModelOpen) setSummaryModel(fallbackModel)
  }, [summaryModelOpen, fallbackModel])

  const handleManualRefresh = async () => {
    if (!item) return
    setManualRefreshing(true)
    try {
      const fresh = await fetchLedgerItemByKey(item)
      if (fresh) onItemRefreshed?.(fresh)
    } catch {
      // 静默；用户可在 header 再次点击重试
    } finally {
      setManualRefreshing(false)
    }
  }

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
          data-warm-ledger-dialog="true"
          aria-describedby={undefined}
          className={cn(
            styles.dialogContent,
            styles.dialogWide,
            styles.dialogFlush,
            'flex flex-col overflow-hidden p-0 gap-0'
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
                      disabled={manualRefreshing}
                      className="h-7 w-7 rounded-[var(--warm-ledger-radius-inner)] text-[color:var(--warm-ledger-color-text-muted)] hover:text-[color:var(--warm-ledger-color-text)]"
                      aria-label="刷新 AI 摘要"
                      title="刷新 AI 摘要"
                    >
                      <RotateCcw
                        className={cn('h-3.5 w-3.5', manualRefreshing && 'animate-spin')}
                      />
                    </Button>
                  )}
                </div>
                <DialogTitle className="font-mono text-lg font-semibold tabular-nums tracking-tight text-[color:var(--warm-ledger-color-text)]">
                  {format(new Date(item.expected_at), 'yyyy-MM-dd · HH:mm')}
                </DialogTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-xs tabular-nums text-[color:var(--warm-ledger-color-text-muted)]">
                  <span className="font-sans">{item.email}</span>
                  <span className="font-sans">{FREQUENCY_LABELS[item.frequency]}</span>
                  {countryList.length > 0 && (
                    <span className="font-sans">
                      {countryList.map(getCountryLabel).join(' · ')}
                    </span>
                  )}
                </div>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {item.status === 'failed' && item.error_message && (
                  <div className="border border-[color:color-mix(in_srgb,var(--warm-ledger-color-negative)_40%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-negative)_10%,transparent)] p-2">
                    <div className="mb-1 flex items-center gap-2 font-sans text-xs font-medium text-[color:var(--warm-ledger-color-negative)]">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      错误信息
                    </div>
                    <div className="whitespace-pre-wrap font-sans text-xs text-[color:var(--warm-ledger-color-negative)]">
                      {item.error_message}
                    </div>
                  </div>
                )}

                <div>
                  <span className={styles.sectionLabel}>报告范围</span>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-sans text-xs text-[color:var(--warm-ledger-color-text-muted)]">
                    {visibleProjects.map((name, idx) => (
                      <span
                        key={`${name}-${idx}`}
                        className="border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-1.5 py-px font-sans"
                      >
                        {name}
                      </span>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(true)}
                        className="tabular-nums text-[color:var(--warm-ledger-color-accent-strong)] underline-offset-2 hover:underline"
                      >
                        +{hiddenCount} 更多
                      </button>
                    )}
                    {showAllProjects && projectNames.length > MAX_VISIBLE_PROJECTS && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(false)}
                        className="text-[color:var(--warm-ledger-color-accent-strong)] underline-offset-2 hover:underline"
                      >
                        收起
                      </button>
                    )}
                  </div>
                  {countryList.length > 0 && (
                    <div className="mt-2 font-sans text-xs text-[color:var(--warm-ledger-color-text-muted)]">
                      {countryList.map(getCountryLabel).join(' · ')}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <span className={styles.sectionLabel}>报告截图</span>
                    {item.screenshot_r2_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewScreenshot(item.screenshot_r2_url)}
                        className="group relative aspect-[3/4] max-h-[60vh] w-full overflow-hidden rounded-[var(--warm-ledger-radius-inner)] border border-[color:var(--warm-ledger-color-hairline)] transition-colors hover:border-[color:var(--warm-ledger-color-hairline-strong)] bg-[var(--warm-ledger-color-panel-strong)]"
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
                      <div className="flex min-h-[200px] items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-dashed border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-text-faint)]">
                        <ImageIcon className="h-4 w-4" aria-hidden />
                        暂无截图
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className={cn(styles.sectionLabel, 'mb-0')}>AI 文案</span>
                      <div className="flex items-center gap-2">
                        {canRegenerateSummary && (
                          <Popover open={summaryModelOpen} onOpenChange={setSummaryModelOpen}>
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                disabled={regeneratingAiSummary || isLoadingModelConfig}
                                className="flex items-center gap-1 font-sans text-[11px] text-[color:var(--warm-ledger-color-accent-strong)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                                aria-label={summaryActionLabel}
                              >
                                {regeneratingAiSummary ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : summaryInterrupt ? (
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
                                  {summaryInterrupt
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
                                    {summaryInterrupt ? '打断并重新生成' : '确认生成'}
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
                            onClick={() => onCopy(ledgerCopyText(item.ai_summary!))}
                            className={styles.copyAction}
                            aria-label="复制 AI 文案"
                          >
                            <Copy className="h-3 w-3" />
                            复制
                          </button>
                        )}
                      </div>
                    </div>
                    <InsightStreamPanel
                      status={panel.state.status}
                      statusLabel={panel.state.label}
                      progress={panel.state.progress}
                      error={panel.error}
                      backgroundMessage={panel.backgroundMessage}
                      content={panel.content}
                      contentState={panel.contentState}
                      isStreaming={panel.state.isStreaming}
                      digest={panel.digest}
                      onRetry={canRegenerateSummary ? panel.onRetry : undefined}
                      onCancel={canTriggerResend ? panel.onCancel : undefined}
                      exportFileName={`AI摘要-${item.expected_date}.md`}
                      className={styles.insightPanel}
                      contentClassName={styles.insightContent}
                      emptyState={
                        panel.state.status === 'failed' ? (
                          <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-[color:color-mix(in_srgb,var(--warm-ledger-color-negative)_40%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-negative)_10%,transparent)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-negative)]">
                            <AlertTriangle className="h-4 w-4" aria-hidden />
                            <span>
                              {runBound
                                ? '本轮生成中断，可重新开始'
                                : item.ai_summary_error || '本轮生成失败，可重新开始'}
                            </span>
                            {canRegenerateSummary && !panel.onRetry && (
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid="regenerate-summary-retry"
                                disabled={isLoadingModelConfig}
                                onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                                className="mt-1 font-sans text-xs text-[color:var(--warm-ledger-color-negative)] hover:bg-[var(--warm-ledger-color-raised-hover)]"
                              >
                                <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                                重新生成
                              </Button>
                            )}
                          </div>
                        ) : panel.state.busy ? (
                          <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-[color:color-mix(in_srgb,var(--warm-ledger-color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--warm-ledger-color-accent)_10%,transparent)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-accent-strong)]">
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            <span>正在为你生成摘要，稍候内容会出现在这里</span>
                            {canRegenerateSummary && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={regeneratingAiSummary}
                                onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                                className="font-sans text-xs text-[color:var(--warm-ledger-color-accent-strong)] hover:bg-[var(--warm-ledger-color-raised-hover)]"
                              >
                                <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                                打断并重新生成
                              </Button>
                            )}
                          </div>
                        ) : panel.state.status === 'cancelled' ? (
                          <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-dashed border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-text-faint)]">
                            <Square className="h-4 w-4" aria-hidden />
                            <span>本轮生成已取消</span>
                            {canRegenerateSummary && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isLoadingModelConfig}
                                onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                                className="mt-1 font-sans text-xs text-[color:var(--warm-ledger-color-accent-strong)] hover:bg-[var(--warm-ledger-color-raised-hover)]"
                              >
                                <Sparkles className="mr-1 h-3 w-3" aria-hidden />
                                重新开始
                              </Button>
                            )}
                          </div>
                        ) : panel.state.status === 'queued' || panel.state.status === 'idle' ? (
                          // BLF-822：报告已发送但摘要尚未生成（后端不再自动生成），
                          // 主行动是手动触发一次生成。
                          <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-dashed border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-text-faint)]">
                            <Sparkles className="h-4 w-4 text-[color:var(--warm-ledger-color-accent-strong)]" aria-hidden />
                            <span>报告已发送，尚未生成 AI 摘要</span>
                            {canRegenerateSummary && (
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid="generate-summary-cta"
                                disabled={isLoadingModelConfig}
                                onClick={() => onRegenerateAiSummary(item, fallbackModel || null)}
                                className="mt-1 font-sans text-xs text-[color:var(--warm-ledger-color-accent-strong)] hover:bg-[var(--warm-ledger-color-raised-hover)]"
                              >
                                <Sparkles className="mr-1 h-3 w-3" aria-hidden />
                                生成 AI 摘要
                              </Button>
                            )}
                          </div>
                        ) : (
                          <div className="flex min-h-[200px] items-center justify-center gap-2 rounded-[var(--warm-ledger-radius-inner)] border border-dashed border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-3 py-12 font-sans text-xs text-[color:var(--warm-ledger-color-text-faint)]">
                            <FileText className="h-4 w-4" aria-hidden />
                            暂无 AI 文案
                          </div>
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {canTrigger && item && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] px-4 py-2.5">
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
