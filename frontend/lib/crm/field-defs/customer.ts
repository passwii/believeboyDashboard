import type { FieldDefinition } from '@/lib/crm/types/field'
import {
  CUSTOMER_RATING_LABELS,
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'

function toOptions(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }))
}

/**
 * 客户详情字段清单（v1.2 引入）。
 * 写死字段值（D5），仅把"展示哪些字段 + 如何渲染"集中为数组，
 * 供 `crm-detail-card` 统一渲染。线索/商机复用同一卡片换各自 FIELD_DEFS。
 */
export const CUSTOMER_FIELD_DEFS: FieldDefinition[] = [
  { key: 'name', label: '客户名', type: 'text' },
  { key: 'shortName', label: '简称', type: 'text' },
  { key: 'industry', label: '行业', type: 'text' },
  { key: 'rating', label: '等级', type: 'select', options: toOptions(CUSTOMER_RATING_LABELS) },
  { key: 'status', label: '状态', type: 'select', options: toOptions(CUSTOMER_STATUS_LABELS) },
  { key: 'source', label: '来源', type: 'select', options: toOptions(CUSTOMER_SOURCE_LABELS) },
  { key: 'ownerName', label: '负责人', type: 'text' },
  { key: 'contactName', label: '联系人', type: 'text' },
  { key: 'contactPhone', label: '联系电话', type: 'phone' },
  { key: 'contactEmail', label: '联系邮箱', type: 'email' },
  { key: 'address', label: '地址', type: 'text' },
  { key: 'website', label: '官网', type: 'url' },
  { key: 'annualRevenue', label: '年营收', type: 'number' },
  { key: 'employeeCount', label: '员工数', type: 'number' },
  { key: 'lastFollowAt', label: '最后跟进', type: 'date' },
  { key: 'remark', label: '备注', type: 'textarea' },
]
