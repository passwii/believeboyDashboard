'use client'

import { cn } from '@/lib/utils'
import { DetailFieldRow } from './field-renderer'
import type { CrmDetailCardProps } from './types'
import styles from './crm-detail-card-warm.module.css'

/**
 * 通用详情卡片（v1.2）：按 `fields: FieldDefinition[]` 渲染实体字段。
 * 客户/线索/商机/公海复用同一卡片，仅换 FIELD_DEFS（对齐 CordysCRM 范式）。
 * Warm Ledger：面板浮层 + 字段行 hairline；字段渲染契约保持不变。
 */
export function CrmDetailCard({ fields, data, title, headerExtra, className }: CrmDetailCardProps) {
  return (
    <div className={cn(styles.card, className)}>
      {(title || headerExtra) && (
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          {headerExtra}
        </div>
      )}
      <dl className={styles.list}>
        {fields.map((field) => (
          <DetailFieldRow key={field.key} field={field} value={data[field.key]} />
        ))}
      </dl>
    </div>
  )
}
