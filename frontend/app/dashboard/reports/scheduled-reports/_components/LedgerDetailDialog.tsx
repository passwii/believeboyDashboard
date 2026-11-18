'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import {
  AlertTriangle,
  Copy,
  FileText,
  ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { InsightStreamPanel } from '@/components/insight/insight-stream-panel'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import {
  WarmButton,
  WarmIconButton,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import { formatLedgerBeijingTime } from './LedgerDayGroup'
import { FREQUENCY_LABELS, emailDisplayLabel } from './ledger-constants'
import { fetchLedgerItemByKey } from './api'
import { ledgerCopyText } from './ledger-insight'
import { useLedgerInsight } from './use-ledger-insight'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'
import styles from './ledger-warm.module.css'

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
  // Warm token 只定义在 #warm-ledger-portal-root 子树内；显式 portal 到该根节点，
  // 避免弹窗与内部下拉的 var() 在 body 下失效导致透明。
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  const expectedTime = item ? formatLedgerBeijingTime(item.expected_at) : null
  const completedTime = item?.sent_at ? formatLedgerBeijingTime(item.sent_at) : null
  const sub = item ? subscriptions.find((s) => s.id === item.subscription_id) : undefined
  const hasEmail = !!item?.email?.trim()
  // 历史 Python 路径可能在「无邮箱仅生成」时也写入 sent_at，因此 materialized
  // email_sent 不能单独判断是否发过邮件：只有有邮箱且 email_sent=true 才算发送成功。
  const sentByEmail = hasEmail && !!item?.email_sent
  const heroLabel = item
    ? item.status === 'sent'
      ? sentByEmail
        ? { text: '✓ 发送成功', tone: 'positive' as const }
        : { text: '✓ 生成成功', tone: 'positive' as const }
      : item.status === 'failed'
        ? hasEmail
          ? { text: '✗ 发送失败', tone: 'negative' as const }
          : { text: '✗ 生成失败', tone: 'negative' as const }
        : { text: '⚠ 记录缺失', tone: 'accent' as const }
    : null
  const fallbackModel = item ? sub?.ai_model || modelConfig?.defaultModel || '' : ''
  // `can_resend` 是状态资格位，不是调用者权限；两个端点在 Go 侧都要求管理员。
  const canTrigger = !!item && canTriggerResend
  const canRegenerateSummary = !!item && canTriggerResend && item.status === 'sent'
  // BLF-822：`pending` 表示「尚未生成、等待手动触发」，只有 `generating` 代表后台正在跑。
  // 重新生成等场景下 AI 摘要仍可能卡死在 generating，保留「打断并重新生成」作为卡死救援入口。
  const summaryGenerating =
    !regeneratingAiSummary && !!item && item.ai_summary_status === 'generating'
  // BLF-1015：`generating` 且有既存摘要时，详情已能看到后台进度，入口只负责「另起一轮」；
  // 没有既存摘要才需要「打断并重新生成」这样的卡死救援语义。
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
  const countryLabels = countryList.map((country) => getCountryLabel(country))
  const visibleProjects = showAllProjects
    ? projectNames
    : projectNames.slice(0, MAX_VISIBLE_PROJECTS)
  const hiddenCount = projectNames.length - visibleProjects.length

  const modelOptions: WarmSelectOption[] = []
  if (fallbackModel) {
    modelOptions.push({ value: fallbackModel, label: `订阅预设：${fallbackModel}` })
  }
  for (const model of modelConfig?.premiumModels ?? []) {
    if (model !== fallbackModel) modelOptions.push({ value: model, label: `高级模型：${model}` })
  }
  for (const model of modelConfig?.basicModels ?? []) {
    if (model !== fallbackModel && !modelConfig?.premiumModels.includes(model)) {
      modelOptions.push({ value: model, label: `基础模型：${model}` })
    }
  }
  for (const model of modelConfig?.models ?? []) {
    if (
      model !== fallbackModel &&
      !modelConfig?.premiumModels.includes(model) &&
      !modelConfig?.basicModels.includes(model)
    ) {
      modelOptions.push({ value: model, label: model })
    }
  }

  const summaryRetryFallback = fallbackModel || null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          portalContainer={portalContainer}
          data-warm-ledger-dialog="true"
          aria-describedby={undefined}
          className={styles.dialogContent}
        >
          {item ? (
            <>
              <div className={styles.dialogHead}>
                <div className={styles.dialogHeadMain}>
                  {heroLabel ? (
                    <span className={styles.dialogStatus} data-tone={heroLabel.tone}>
                      {heroLabel.text}
                    </span>
                  ) : null}
                  <DialogTitle className={styles.dialogTitle}>
                    {expectedTime ? `${expectedTime.date} · ${expectedTime.time}` : '—'}
                  </DialogTitle>
                </div>
                {canTriggerResend ? (
                  <WarmIconButton
                    onClick={handleManualRefresh}
                    disabled={manualRefreshing}
                    aria-label="刷新 AI 摘要"
                    title="刷新 AI 摘要"
                  >
                    <RotateCcw className={manualRefreshing ? 'animate-spin' : undefined} />
                  </WarmIconButton>
                ) : null}
                <DialogClose asChild>
                  <WarmIconButton aria-label="关闭详情">
                    <X />
                  </WarmIconButton>
                </DialogClose>
              </div>

              <div className={styles.dialogBody}>
                <section className={styles.section} aria-labelledby="ledger-detail-overview">
                  <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle} id="ledger-detail-overview">
                      概览
                    </h3>
                  </div>
                  <div className={styles.overviewGrid}>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>项目</span>
                      <div className={`${styles.projectChips} font-sans`}>
                        {visibleProjects.map((name, idx) => (
                          <span key={`${name}-${idx}`} className={`${styles.projectChip} font-sans`}>
                            {name}
                          </span>
                        ))}
                        {hiddenCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setShowAllProjects(true)}
                            className={styles.copyAction}
                          >
                            +{hiddenCount} 更多
                          </button>
                        ) : null}
                        {showAllProjects && projectNames.length > MAX_VISIBLE_PROJECTS ? (
                          <button
                            type="button"
                            onClick={() => setShowAllProjects(false)}
                            className={styles.copyAction}
                          >
                            收起
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>国家站点</span>
                      <span className={`${styles.fieldValue} font-sans`}>
                        {countryLabels.length > 0 ? countryLabels.join(' · ') : '—'}
                      </span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>接收邮箱</span>
                      <span className={`${styles.fieldValue} font-sans`} dir="ltr">
                        {emailDisplayLabel(item.email)}
                      </span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>频率</span>
                      <span className={styles.fieldValue}>
                        {FREQUENCY_LABELS[item.frequency]}
                      </span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>应发时间</span>
                      <span className={`${styles.fieldValue} ${styles.fieldValueMono}`}>
                        {expectedTime?.dateTimeWithSeconds ?? '—'}
                      </span>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>完成时间</span>
                      <span className={`${styles.fieldValue} ${styles.fieldValueMono}`}>
                        {completedTime?.dateTimeWithSeconds ?? '—'}
                      </span>
                    </div>
                  </div>
                </section>

                <section className={styles.section} aria-labelledby="ledger-detail-summary">
                  <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle} id="ledger-detail-summary">
                      AI 摘要
                    </h3>
                    <div className={styles.sectionMeta}>
                      {canRegenerateSummary ? (
                        <Popover open={summaryModelOpen} onOpenChange={setSummaryModelOpen}>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              disabled={regeneratingAiSummary || isLoadingModelConfig}
                              className={styles.summaryAction}
                              aria-label={summaryActionLabel}
                            >
                              {regeneratingAiSummary ? (
                                <Loader2 className="animate-spin" aria-hidden />
                              ) : summaryInterrupt ? (
                                <Square aria-hidden />
                              ) : (
                                <Sparkles aria-hidden />
                              )}
                              {summaryActionLabel}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            portalContainer={portalContainer}
                            className={styles.resendPopover}
                            align="end"
                          >
                            <div className={styles.resendTitle}>{summaryActionLabel}</div>
                            <p className={styles.resendNote}>
                              {summaryInterrupt
                                ? '后台生成似乎已卡住，会终止上一轮并启动新一轮 AI 摘要。不会重新截图或发送邮件。'
                                : '只生成 AI 摘要，不会重新截图或发送邮件。'}
                            </p>
                            <span className={styles.resendFieldLabel}>使用模型</span>
                            <WarmSelect
                              id="ledger-summary-model"
                              hideLabel
                              ariaLabel="使用模型"
                              className={styles.modelSelect}
                              value={summaryModel || 'unavailable'}
                              options={
                                modelOptions.length > 0
                                  ? modelOptions
                                  : [
                                      {
                                        value: 'unavailable',
                                        label: isLoadingModelConfig
                                          ? '加载模型中…'
                                          : '暂无可用模型',
                                      },
                                    ]
                              }
                              onChange={setSummaryModel}
                              disabled={isLoadingModelConfig || !modelConfig?.models.length}
                              placeholder={isLoadingModelConfig ? '加载模型中…' : '选择模型'}
                            />
                            <div className={styles.resendActions}>
                              <WarmButton
                                variant="primary"
                                disabled={!summaryModel || regeneratingAiSummary}
                                onClick={() => {
                                  setSummaryModelOpen(false)
                                  onRegenerateAiSummary(item, summaryModel)
                                }}
                              >
                                {summaryInterrupt ? '打断并重新生成' : '确认生成'}
                              </WarmButton>
                              <WarmButton variant="quiet" onClick={() => setSummaryModelOpen(false)}>
                                取消
                              </WarmButton>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : null}
                      {item.ai_summary ? (
                        <button
                          type="button"
                          onClick={() => onCopy(ledgerCopyText(item.ai_summary!))}
                          className={styles.copyAction}
                          aria-label="复制 AI 文案"
                        >
                          <Copy aria-hidden />
                          复制
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <InsightStreamPanel
                    appearance="warm"
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
                        <div className={styles.insightEmpty} data-tone="failed">
                          <AlertTriangle aria-hidden />
                          <span>
                            {runBound
                              ? '本轮生成中断，可重新开始'
                              : item.ai_summary_error || '本轮生成失败，可重新开始'}
                          </span>
                          {canRegenerateSummary && !panel.onRetry ? (
                            <WarmButton
                              data-testid="regenerate-summary-retry"
                              disabled={isLoadingModelConfig}
                              onClick={() =>
                                onRegenerateAiSummary(item, summaryRetryFallback)
                              }
                              className="font-sans text-xs"
                            >
                              <RotateCcw aria-hidden />
                              重新生成
                            </WarmButton>
                          ) : null}
                        </div>
                      ) : panel.state.busy ? (
                        <div className={styles.insightEmpty} data-tone="busy">
                          <Loader2 className="animate-spin" aria-hidden />
                          <span>正在为你生成摘要，稍候内容会出现在这里</span>
                          {canRegenerateSummary ? (
                            <WarmButton
                              variant="quiet"
                              disabled={regeneratingAiSummary}
                              onClick={() =>
                                onRegenerateAiSummary(item, summaryRetryFallback)
                              }
                              className="font-sans text-xs"
                            >
                              <RotateCcw aria-hidden />
                              打断并重新生成
                            </WarmButton>
                          ) : null}
                        </div>
                      ) : panel.state.status === 'cancelled' ? (
                        <div className={styles.insightEmpty}>
                          <Square aria-hidden />
                          <span>本轮生成已取消</span>
                          {canRegenerateSummary ? (
                            <WarmButton
                              disabled={isLoadingModelConfig}
                              onClick={() =>
                                onRegenerateAiSummary(item, summaryRetryFallback)
                              }
                              className="font-sans text-xs"
                            >
                              <Sparkles aria-hidden />
                              重新开始
                            </WarmButton>
                          ) : null}
                        </div>
                      ) : panel.state.status === 'queued' || panel.state.status === 'idle' ? (
                        // BLF-822：报告已发送但摘要尚未生成（后端不再自动生成），
                        // 主行动是手动触发一次生成。
                        <div className={styles.insightEmpty}>
                          <Sparkles aria-hidden />
                          <span>报告已发送，尚未生成 AI 摘要</span>
                          {canRegenerateSummary ? (
                            <WarmButton
                              data-testid="generate-summary-cta"
                              disabled={isLoadingModelConfig}
                              onClick={() =>
                                onRegenerateAiSummary(item, summaryRetryFallback)
                              }
                              className="font-sans text-xs"
                            >
                              <Sparkles aria-hidden />
                              生成 AI 摘要
                            </WarmButton>
                          ) : null}
                        </div>
                      ) : (
                        <div className={styles.insightEmpty}>
                          <FileText aria-hidden />
                          暂无 AI 文案
                        </div>
                      )
                    }
                  />
                </section>

                <section className={styles.section} aria-labelledby="ledger-detail-screenshot">
                  <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle} id="ledger-detail-screenshot">
                      截图
                    </h3>
                  </div>
                  {item.screenshot_r2_url ? (
                    <button
                      type="button"
                      onClick={() => setPreviewScreenshot(item.screenshot_r2_url)}
                      className={styles.screenshotButton}
                      aria-label="查看报告截图大图"
                    >
                      <Image
                        src={item.screenshot_r2_thumb_url || item.screenshot_r2_url}
                        alt="报告截图"
                        fill
                        className={styles.screenshotImage}
                        unoptimized
                      />
                    </button>
                  ) : (
                    <div className={styles.screenshotEmpty}>
                      <ImageIcon aria-hidden />
                      暂无截图
                    </div>
                  )}
                </section>

                {item.error_message ? (
                  <section className={styles.section} aria-labelledby="ledger-detail-error">
                    <div className={styles.sectionHead}>
                      <h3 className={styles.sectionTitle} id="ledger-detail-error">
                        错误
                      </h3>
                    </div>
                    <div className={styles.errorBox}>
                      <div className={styles.errorHead}>
                        <AlertTriangle aria-hidden />
                        错误信息
                      </div>
                      <p className={styles.errorText}>{item.error_message}</p>
                    </div>
                  </section>
                ) : null}
              </div>

              {canTrigger ? (
                <div className={styles.dialogFooter}>
                  <span className={styles.dialogFooterNote}>重新生成不会发送邮件</span>
                  <span className={styles.dialogFooterSpacer} />
                  <WarmButton variant="quiet" onClick={() => onOpenChange(false)}>
                    关闭
                  </WarmButton>
                  <LedgerResendCell
                    item={item}
                    resendingStage={resendingStage}
                    canResend
                    modelConfig={modelConfig}
                    isLoadingModelConfig={isLoadingModelConfig}
                    fallbackModel={fallbackModel}
                    triggerClassName={styles.resendTriggerFooter}
                    onLoading={() => onResendLoading(item)}
                    onSubmit={(overrideAiModel) => {
                      onResend(item, overrideAiModel)
                      onOpenChange(false)
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {previewScreenshot ? (
        <PortraitScreenshotDialog
          open
          onOpenChange={(nextOpen) => !nextOpen && setPreviewScreenshot(null)}
          src={previewScreenshot}
          alt="报告截图"
        />
      ) : null}
    </>
  )
}
