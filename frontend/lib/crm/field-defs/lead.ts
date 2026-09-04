import type { FieldDefinition } from '@/lib/crm/types/field'
import { LEAD_INTENT_LABELS, LEAD_STATUS_LABELS } from '@/lib/crm/enums/lead.enum'
import { CUSTOMER_SOURCE_LABELS } from '@/lib/crm/enums/customer.enum'

function toOptions(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

/** 线索详情字段清单（复用 crm-detail-card，换此 FIELD_DEFS）。 */
export const LEAD_FIELD_DEFS: FieldDefinition[] = [
  { key: 'name', label: '联系人', type: 'text' },
  { key: 'company', label: '公司', type: 'text' },
  { key: 'phone', label: '电话', type: 'phone' },
  { key: 'email', label: '邮箱', type: 'email' },
  { key: 'wechat', label: '微信', type: 'text' },
  { key: 'source', label: '来源', type: 'select', options: toOptions(CUSTOMER_SOURCE_LABELS) },
  { key: 'status', label: '状态', type: 'select', options: toOptions(LEAD_STATUS_LABELS) },
  { key: 'intent', label: '意向', type: 'select', options: toOptions(LEAD_INTENT_LABELS) },
  { key: 'ownerName', label: '负责人', type: 'text' },
  { key: 'expectedAmount', label: '预计金额', type: 'number' },
  { key: 'expectedCloseDate', label: '预计成交', type: 'date' },
  { key: 'remark', label: '备注', type: 'textarea' },
]
