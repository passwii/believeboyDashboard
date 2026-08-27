'use client'

import { cn } from '@/lib/utils'
import { DetailFieldRow } from './field-renderer'
import type { CrmDetailCardProps } from './types'

/**
 * 通用详情卡片（v1.2）：按 `fields: FieldDefinition[]` 渲染实体字段。
 * 客户/线索/商机/公海复用同一卡片，仅换 FIELD_DEFS（对齐 CordysCRM 范式）。
 * BLF-856：去 Card 壳，改 term 边界/零圆角/mono 小字，与 TermPanel 同规格。
 */
export function CrmDetailCard({ fields, data, title, headerExtra, className }: CrmDetailCardProps) {
  return (
    <div className={cn('rounded-none border border-term-border bg-term-panel shadow-none', className)}>
      {(title || headerExtra) && (
        <div className="flex h-9 items-center justify-between gap-2 border-b border-term-border px-2">
          <h3 className="truncate font-mono text-xs uppercase tracking-wider text-term-muted">{title}</h3>
          {headerExtra}
        </div>
      )}
      <dl className="divide-y divide-term-border px-2">
        {fields.map((field) => (
          <DetailFieldRow key={field.key} field={field} value={data[field.key]} />
        ))}
      </dl>
    </div>
  )
}
