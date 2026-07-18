import type { FieldDefinition } from '@/lib/crm/types/field'

export interface CrmDetailCardProps {
  /** 字段清单（按展示顺序）；线索/商机复用同一卡片换各自 FIELD_DEFS */
  fields: FieldDefinition[]
  /** 实体数据对象，按 field.key 取字段值 */
  data: Record<string, unknown>
  /** 标题（如客户名）；可选 */
  title?: string
  /** 标题右侧徽章（如状态/等级）；可选 */
  headerExtra?: React.ReactNode
  className?: string
}
