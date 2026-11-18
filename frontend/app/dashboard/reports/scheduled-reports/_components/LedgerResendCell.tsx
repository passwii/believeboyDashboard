'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  WarmButton,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'
import type { AIModelConfig, LedgerItem, ResendStage } from './types'
import styles from './ledger-warm.module.css'

const RESEND_STAGE_LABELS: Record<ResendStage, string> = {
  preparing: '准备中',
  fetching_data: '获取数据',
  generating_summary: '生成 AI 摘要',
  rendering_html: '渲染报告',
  capturing_screenshot: '生成截图',
  sending: '完成处理',
  done: '已完成',
  failed: '失败',
}

/**
 * 台账行内的「重新生成」操作单元。
 *
 * 后端 resend 接口统一走 skip_email：即使订阅有邮箱也不会发信，因此文案
 * 固定为「重新生成 / 重试生成」，并明确说明不会发送邮件；无邮箱行同样保留入口。
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
  onRequestModelConfig,
  triggerClassName,
}: {
  item: LedgerItem
  resendingStage: ResendStage | undefined
  canResend: boolean
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  fallbackModel: string
  onSubmit: (overrideAiModel: string | null) => void
  onLoading: () => void
  /** BEL-422：打开模型选择下拉时通知父级按需加载模型配置（首屏不预拉） */
  onRequestModelConfig?: () => void
  /** 详情弹窗页脚等场景替换触发器外观（文字与行为保持不变）。 */
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const modelSelectId = useId()
  const actionLabel = item.status === 'failed' ? '重试生成' : '重新生成'
  const defaultModel = fallbackModel || modelConfig?.defaultModel || ''
  const [selectedModel, setSelectedModel] = useState<string>(defaultModel)
  // 用户主动选过模型后，不再被晚到的默认值（订阅 ai_model / 系统配置）覆盖
  const userPickedModel = useRef(false)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  useEffect(() => {
    if (open) {
      userPickedModel.current = false
      setSelectedModel(defaultModel)
      // BEL-422：模型配置按需加载 —— 打开下拉才拉取
      onRequestModelConfig?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && !userPickedModel.current) setSelectedModel(defaultModel)
  }, [open, defaultModel])

  if (!canResend) {
    return <span className={styles.thumbNone}>—</span>
  }

  if (resendingStage) {
    return (
      <div className={styles.inlineLoading} role="status">
        <Loader2 className={styles.spinner} aria-hidden />
        <span data-stage={resendingStage}>{RESEND_STAGE_LABELS[resendingStage]}</span>
      </div>
    )
  }

  // 模型清单按现有优先级摊平：订阅预设 > 高级模型 > 基础模型 > 其余可用模型。
  const modelOptions: WarmSelectOption[] = []
  if (defaultModel) {
    modelOptions.push({ value: defaultModel, label: `订阅预设：${defaultModel}` })
  }
  for (const model of modelConfig?.premiumModels ?? []) {
    if (model !== defaultModel) modelOptions.push({ value: model, label: `高级模型：${model}` })
  }
  for (const model of modelConfig?.basicModels ?? []) {
    if (model !== defaultModel && !modelConfig?.premiumModels.includes(model)) {
      modelOptions.push({ value: model, label: `基础模型：${model}` })
    }
  }
  for (const model of modelConfig?.models ?? []) {
    if (
      model !== defaultModel &&
      !modelConfig?.premiumModels.includes(model) &&
      !modelConfig?.basicModels.includes(model)
    ) {
      modelOptions.push({ value: model, label: model })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(styles.resendTrigger, triggerClassName)}
          title="只重新生成报告与摘要，不会发送邮件"
        >
          {actionLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent
        portalContainer={portalContainer}
        className={styles.resendPopover}
        align="end"
      >
        <div>
          <div className={styles.resendTitle}>{actionLabel}报告</div>
          <p className={styles.resendNote}>
            重新生成报告（数据 / 截图 / AI 摘要），不会发送邮件。可临时选择本次执行使用的
            AI 模型（不影响订阅默认模型）。
          </p>
          <span className={styles.resendFieldLabel}>使用模型</span>
          <WarmSelect
            id={modelSelectId}
            hideLabel
            ariaLabel="使用模型"
            className={styles.modelSelect}
            value={selectedModel || 'unavailable'}
            options={
              modelOptions.length > 0
                ? modelOptions
                : [
                    {
                      value: 'unavailable',
                      label: isLoadingModelConfig ? '加载模型中…' : '暂无可用模型',
                    },
                  ]
            }
            onChange={(value) => {
              userPickedModel.current = true
              setSelectedModel(value)
            }}
            disabled={isLoadingModelConfig || !modelConfig?.models.length}
            placeholder={isLoadingModelConfig ? '加载模型中…' : '选择模型'}
          />
          <div className={styles.resendActions}>
            <WarmButton
              variant="primary"
              disabled={!selectedModel}
              onClick={() => {
                onLoading()
                setOpen(false)
                onSubmit(selectedModel)
              }}
            >
              确认{actionLabel}
            </WarmButton>
            <WarmButton variant="quiet" onClick={() => setOpen(false)}>
              取消
            </WarmButton>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
