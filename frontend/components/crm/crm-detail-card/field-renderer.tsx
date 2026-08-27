import type { FieldDefinition } from '@/lib/crm/types/field'
import { renderField } from '@/lib/crm/method/render-field'

/** 单字段行：label + 渲染值。集中处理空态与排列（BLF-856 终端：mono 标签/term 令牌）。 */
export function DetailFieldRow({ field, value }: { field: FieldDefinition; value: unknown }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-2 text-sm">
      <dt className="shrink-0 font-mono text-xs uppercase tracking-wider text-term-muted">{field.label}</dt>
      <dd className="min-w-0 break-words text-sm text-term-text">{renderField(field, value)}</dd>
    </div>
  )
}
