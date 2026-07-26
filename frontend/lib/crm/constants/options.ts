/**
 * CRM 共享常量（P5-5）
 *
 * customerType / interestedService 当前在客户表 + 线索表重复硬编码；
 * 抽到此处统一管理，后续加值改一处两表生效。
 *
 * 注意：customer + lead 共享同一组 customerType / interestedService 取值；
 * 如未来需拆分（客户行业 vs 线索来源），把两个常量拆开再分别引用即可。
 */

export const CUSTOMER_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '工厂', label: '工厂' },
  { value: '贸易商', label: '贸易商' },
  { value: '同行', label: '同行' },
  { value: '其他', label: '其他' },
]

export const INTERESTED_SERVICE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '代运营', label: '代运营' },
  { value: 'AI运营', label: 'AI运营' },
  { value: '运营服务', label: '运营服务' },
  { value: '其他', label: '其他' },
]