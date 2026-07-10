'use client'

import { useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { AIModelConfig, LedgerItem, ResendStage } from './types'

const RESEND_STAGE_LABELS: Record<ResendStage, string> = {
  preparing: '准备中',
  fetching_data: '获取数据',
  generating_summary: '生成 AI 摘要',
  rendering_html: '渲染报告',
  capturing_screenshot: '生成截图',
  sending: '发送邮件',
  done: '已完成',
  failed: '失败',
}

const RESEND_STAGE_COLORS: Record<ResendStage, string> = {
  preparing: 'text-amber-600 dark:text-amber-400',
  fetching_data: 'text-sky-600 dark:text-sky-400',
  generating_summary: 'text-violet-600 dark:text-violet-400',
  rendering_html: 'text-blue-600 dark:text-blue-400',
  capturing_screenshot: 'text-orange-600 dark:text-orange-400',
  sending: 'text-purple-600 dark:text-purple-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
}

/**
 * 台账行内的"重发/补发"操作单元
 */
export function LedgerResendCell({
  item,
  resendingStage,
  canResend,
  modelConfig,
  isLoadingModelConfig,
  fallbackModel,
  onSubmit,
  onLoading,
}: {
  item: LedgerItem
  resendingStage: ResendStage | undefined
  canResend: boolean
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  fallbackModel: string
  onSubmit: (overrideAiModel: string | null) => void
  onLoading: () => void
}) {
  const [open, setOpen] = useState(false)
  const actionLabel = item.status === 'failed' ? '重试' : '补发'
  const defaultModel = fallbackModel || modelConfig?.defaultModel || ''
  const [selectedModel, setSelectedModel] = useState<string>(defaultModel)

  useEffect(() => {
    if (open) setSelectedModel(defaultModel)
  }, [open, defaultModel])

  if (!canResend) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  if (resendingStage) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className={cn('text-sm', RESEND_STAGE_COLORS[resendingStage])}>
          {RESEND_STAGE_LABELS[resendingStage]}
        </span>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <RotateCcw className="mr-1 h-3 w-3" />
          {actionLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-3" align="end">
        <div className="space-y-2">
          <div className="text-sm font-medium">{actionLabel}报告</div>
          <p className="text-xs text-muted-foreground">
            重新生成报告（数据 / 截图 / AI 摘要），不会发送邮件。
            临时选择本次执行使用的 AI 模型（不影响订阅的默认模型设置）。
          </p>
          <div>
            <label className="text-xs font-medium mb-1 block text-muted-foreground">使用模型</label>
            <Select
              value={selectedModel}
              onValueChange={setSelectedModel}
              disabled={isLoadingModelConfig || !modelConfig?.models.length}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'} />
              </SelectTrigger>
              <SelectContent>
                {defaultModel && (
                  <SelectItem value={defaultModel}>
                    <span className="flex items-center gap-1">
                      <span className="text-muted-foreground">订阅预设：</span>
                      <span>{defaultModel}</span>
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
                  .filter(m => !modelConfig.premiumModels.includes(m) && !modelConfig.basicModels.includes(m) && m !== defaultModel)
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
              disabled={!selectedModel}
              onClick={() => {
                onLoading()
                setOpen(false)
                onSubmit(selectedModel)
              }}
            >
              确认{actionLabel}
            </Button>
            <Button size="sm" variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
