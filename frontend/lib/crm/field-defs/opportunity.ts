import type { FieldDefinition } from '@/lib/crm/types/field'
import { OPPORTUNITY_STAGE_LABELS } from '@/lib/crm/enums/opportunity.enum'

function toOptions(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

/** 商机详情字段清单（只读，复用 crm-detail-card，换此 FIELD_DEFS）。 */
export const OPPORTUNITY_FIELD_DEFS: FieldDefinition[] = [
  { key: 'name', label: '商机名', type: 'text' },
  { key: 'customerName', label: '客户', type: 'text' },
  { key: 'amount', label: '金额', type: 'number' },
  { key: 'stage', label: '阶段', type: 'select', options: toOptions(OPPORTUNITY_STAGE_LABELS) },
  { key: 'ownerName', label: '负责人', type: 'text' },
  { key: 'probability', label: '赢单率', type: 'number' },
  { key: 'expectedCloseDate', label: '预计成交', type: 'date' },
  { key: 'remark', label: '备注', type: 'textarea' },
]
