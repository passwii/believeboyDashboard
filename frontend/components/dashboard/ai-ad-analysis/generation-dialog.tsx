'use client'

import { Bot, Sparkles } from 'lucide-react'

import { InsightStreamPanel } from '@/components/insight'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { adScopeLabel } from './ad-insight'
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
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-term-border px-6 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Sparkles className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate">{panel.title ?? 'AI 广告分析'}</span>
          </DialogTitle>
          <p className="text-xs text-term-muted">{scopeLabel}</p>
        </DialogHeader>

        <div className="min-h-0 flex-1 px-4 py-4">
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
            onRetry={panel.onRetry}
            onCancel={panel.onCancel}
            onClose={() => onOpenChange(false)}
            exportFileName={`广告分析-${scopeLabel.replace(/[\\/:*?"<>|]/g, '-')}.md`}
            className="rounded-none border-0 bg-transparent"
            contentClassName="max-h-[55vh] p-0"
            emptyState={
              panel.state.status === 'failed' ? (
                <div className="flex flex-col items-center gap-2 py-10 text-term-neg">
                  <Bot className="h-8 w-8 opacity-40" aria-hidden />
                  <span className="text-xs">本轮广告分析未产出内容</span>
                </div>
              ) : panel.state.busy ? (
                <div className="flex flex-col items-center gap-2 py-10 text-term-muted">
                  <Bot className="h-8 w-8 animate-pulse opacity-40" aria-hidden />
                  <span className="text-xs">{panel.state.label}，内容会实时出现在这里</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-10 text-term-muted">
                  <Bot className="h-8 w-8 opacity-40" aria-hidden />
                  <span className="text-xs">暂无广告分析内容</span>
                </div>
              )
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
