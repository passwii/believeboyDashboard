import type { CustomerSeaImportRow } from '@/lib/crm/types'

export interface ImportColumnDef {
  header: string
  field: keyof CustomerSeaImportRow
  required?: boolean
  hint?: string
}

/** 导入模板/解析共用的 16 列（顺序即模板列序）。 */
export const CRM_IMPORT_COLUMNS: ImportColumnDef[] = [
  { header: '客户名', field: 'name', required: true },
  { header: '简称', field: 'shortName' },
  { header: '行业', field: 'industry' },
  { header: '对象类型', field: 'customerType', hint: '工厂/贸易商/同行/其他' },
  { header: '意向服务', field: 'interestedService', hint: '代运营/AI运营/运营服务/其他' },
  { header: '等级', field: 'rating', hint: 'A/B/C/D' },
  { header: '状态', field: 'status', hint: '活跃/已流失/已签约/暂缓' },
  { header: '来源', field: 'source', hint: '转介绍/展会/线上广告/陌拜/自主开发/其他' },
  { header: '联系人', field: 'contactName' },
  { header: '联系电话', field: 'contactPhone' },
  { header: '联系邮箱', field: 'contactEmail' },
  { header: '地址', field: 'address' },
  { header: '网站', field: 'website' },
  { header: '年营收', field: 'annualRevenue', hint: '数字' },
  { header: '员工数', field: 'employeeCount', hint: '整数' },
  { header: '备注', field: 'remark' },
]

/** 状态标签→值。 */
export const STATUS_LABEL_TO_VALUE: Record<string, string> = {
  活跃: 'active',
  已流失: 'lost',
  已签约: 'signed',
  暂缓: 'on_hold',
}

/** 来源标签→值。 */
export const SOURCE_LABEL_TO_VALUE: Record<string, string> = {
  转介绍: 'referral',
  展会: 'exhibition',
  线上广告: 'online_ad',
  陌拜: 'cold_call',
  自主开发: 'self_developed',
  其他: 'other',
}

export const RATING_VALUES = new Set(['A', 'B', 'C', 'D'])
export const STATUS_VALUES = new Set(['active', 'lost', 'signed', 'on_hold'])
export const SOURCE_VALUES = new Set([
  'referral',
  'exhibition',
  'online_ad',
  'cold_call',
  'self_developed',
  'other',
])
export const CUSTOMER_TYPE_VALUES = new Set(['工厂', '贸易商', '同行', '其他'])
export const INTERESTED_SERVICE_VALUES = new Set(['代运营', 'AI运营', '运营服务', '其他'])
