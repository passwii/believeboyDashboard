import type { FieldDefinition } from '@/lib/crm/types/field'
import { renderField } from '@/lib/crm/method/render-field'
import styles from './crm-detail-card-warm.module.css'

/** 单字段行：label + 渲染值。集中处理空态与排列（BLF-856 终端：mono 标签/term 令牌）。 */
export function DetailFieldRow({ field, value }: { field: FieldDefinition; value: unknown }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{field.label}</dt>
      <dd className={styles.value}>{renderField(field, value)}</dd>
    </div>
  )
}
