import type { FieldDefinition } from '@/lib/crm/types/field'
import { renderField } from '@/lib/crm/method/render-field'

/** 单字段行：label + 渲染值。集中处理空态与排列。 */
export function DetailFieldRow({ field, value }: { field: FieldDefinition; value: unknown }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{field.label}</dt>
      <dd className="min-w-0 break-words">{renderField(field, value)}</dd>
    </div>
  )
}
