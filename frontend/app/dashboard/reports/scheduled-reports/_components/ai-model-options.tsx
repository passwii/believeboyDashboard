'use client'

import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select'
import type { AIModelConfig } from './types'

/**
 * AI 模型下拉的分组选项（高级 / 基础 / 未分类兜底）。
 *
 * 订阅弹窗的「AI 模型」与列表页批量改模型共用这一份归类逻辑（BLF-1032）：
 * premium/basic 分组规则只写一遍，避免两处各自维护后出现选项口径漂移。
 * 仅渲染选项本身，外层 Select / SelectContent 由调用方提供。
 */
export function AiModelOptions({ config }: { config: AIModelConfig | null }) {
  const models = config?.models ?? []
  const premium = config?.premiumModels ?? []
  const basic = config?.basicModels ?? []
  const others = models.filter((m) => !premium.includes(m) && !basic.includes(m))

  return (
    <>
      {premium.length > 0 && (
        <SelectGroup>
          <SelectLabel>高级模型</SelectLabel>
          {premium.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {basic.length > 0 && (
        <SelectGroup>
          <SelectLabel>基础模型</SelectLabel>
          {basic.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {others.map((m) => (
        <SelectItem key={m} value={m}>
          {m}
        </SelectItem>
      ))}
    </>
  )
}
