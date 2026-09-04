import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type { FieldDefinition } from '@/lib/crm/types/field'
import { formatRelativeTime, isOverdueForFollow } from '@/lib/crm/method/format'

/**
 * 通用字段渲染器（v1.2 引入）：详情卡片 / 表单只读预览共用。
 *
 * 不违背 D5（MVP 写死字段值）——这里只把"字段清单"从散落 JSX 提为
 * `FieldDefinition[]` 数组，渲染逻辑集中一处，让客户/线索/商机/公海
 * 复用同一个 `crm-detail-card` 换 `FIELD_DEFS`（对齐 CordysCRM
 * "一个 Drawer 服务多实体" 范式，详见评估 §3.3）。
 */
export function renderField(field: FieldDefinition, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="font-mono text-xs text-term-faint">-</span>
  }

  switch (field.type) {
    case 'select':
    case 'multiselect': {
      const labels = resolveOptionLabels(field, value)
      if (labels.length === 0) return <>{String(value)}</>
      return (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <Badge key={label} variant="secondary" className="rounded-none border border-term-border bg-term-raised font-mono text-xs text-term-muted">
              {label}
            </Badge>
          ))}
        </div>
      )
    }
    case 'date': {
      const iso = String(value)
      // 最后跟进等字段高亮过期
      if (field.key === 'lastFollowAt' && isOverdueForFollow(iso)) {
        return (
          <span className="font-mono tabular-nums text-term-neg">
            {new Date(iso).toLocaleDateString('zh-CN')}
            <span className="ml-1 text-xs">· {formatRelativeTime(iso)}</span>
          </span>
        )
      }
      return <>{new Date(iso).toLocaleDateString('zh-CN')}</>
    }
    case 'number':
      return <>{typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value)}</>
    case 'email':
      return (
        <a href={`mailto:${value}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      )
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {String(value)}
        </a>
      )
    case 'phone':
      return (
        <a href={`tel:${value}`} className="text-primary hover:underline">
          {String(value)}
        </a>
      )
    case 'textarea':
      return <p className="whitespace-pre-wrap text-sm leading-relaxed text-term-text">{String(value)}</p>
    case 'text':
    default:
      return <>{String(value)}</>
  }
}

function resolveOptionLabels(field: FieldDefinition, value: unknown): string[] {
  const options = field.options ?? []
  const byValue = new Map(options.map((o) => [o.value, o.label]))
  if (Array.isArray(value)) {
    return value.map((v) => byValue.get(String(v)) ?? String(v)).filter(Boolean)
  }
  return byValue.get(String(value)) ? [byValue.get(String(value)) as string] : []
}
