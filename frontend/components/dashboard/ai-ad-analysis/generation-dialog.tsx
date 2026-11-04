'use client'

import { Bot, Sparkles } from 'lucide-react'

import { InsightStreamPanel } from '@/components/insight'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { adScopeLabel } from './ad-insight'
import styles from './ai-ad-analysis-warm.module.css'
import { useAdInsight } from './use-ad-insight'

interface GenerationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number | null
  country: string
  dateRange: { from: Date; to: Date }
  onComplete?: () => void
}

/**
 * 广告分析生成弹窗（BLF-1017）。
 *
 * 弹窗只负责容器与领域文案：run 的提交、订阅、重连、恢复、取消、重试全在
 * `useAdInsight` → `useInsightStream`，展示全在 `InsightStreamPanel`。这里
 * 不再有 EventSource、不再解析 SSE、不再自带 Markdown 渲染器。
 *
 * 关闭弹窗 = 与 run 解绑（服务端继续生成），重开时后端按同口径 replay 同一
 * run 并续流，因此生成中、断流重连、后台完成三种情况都能恢复。
 */
export function GenerationDialog({
  open,
  onOpenChange,
  projectId,
  country,
  dateRange,
  onComplete,
}: GenerationDialogProps) {
  const scope = { projectId, country, from: dateRange.from, to: dateRange.to }
  const { panel } = useAdInsight({ open, scope, onSettled: onComplete })
  const scopeLabel = adScopeLabel(scope)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialogContent}>
        <DialogHeader className={styles.dialogHeader}>
          <DialogTitle className={styles.dialogTitle}>
            <Sparkles aria-hidden />
            <span className="truncate">{panel.title ?? 'AI 广告分析'}</span>
          </DialogTitle>
          <p className={styles.dialogMeta}>{scopeLabel}</p>
        </DialogHeader>

        <div className={styles.dialogBody}>
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
            onRetry={panel.onRetry}
            onCancel={panel.onCancel}
            onClose={() => onOpenChange(false)}
            exportFileName={`广告分析-${scopeLabel.replace(/[\\/:*?"<>|]/g, '-')}.md`}
            className={styles.streamFlush}
            contentClassName={styles.streamScroller}
            emptyState={
              panel.state.status === 'failed' ? (
                <div className={styles.emptyState}>
                  <Bot aria-hidden />
                  <span>本轮广告分析未产出内容</span>
                </div>
              ) : panel.state.busy ? (
                <div className={styles.emptyState}>
                  <Bot className="animate-pulse" aria-hidden />
                  <span>{panel.state.label}，内容会实时出现在这里</span>
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <Bot aria-hidden />
                  <span>暂无广告分析内容</span>
                </div>
              )
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
