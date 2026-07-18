'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DetailFieldRow } from './field-renderer'
import type { CrmDetailCardProps } from './types'

/**
 * 通用详情卡片（v1.2）：按 `fields: FieldDefinition[]` 渲染实体字段。
 * 客户/线索/商机/公海复用同一卡片，仅换 FIELD_DEFS（对齐 CordysCRM 范式）。
 */
export function CrmDetailCard({ fields, data, title, headerExtra, className }: CrmDetailCardProps) {
  return (
    <Card className={className}>
      {(title || headerExtra) && (
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {headerExtra}
        </CardHeader>
      )}
      <CardContent>
        <dl className="divide-y divide-border/60">
          {fields.map((field) => (
            <DetailFieldRow key={field.key} field={field} value={data[field.key]} />
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
