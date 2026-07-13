/**
 * 客户名脱敏：保留首尾字符，中间用 * 替代。
 * 用于公海视图，避免敏感信息泄漏给非负责人。
 */
export function maskCustomerName(name: string): string {
  if (!name) return ''
  if (name.length <= 2) return name[0] + '*'
  const head = name.slice(0, 1)
  const tail = name.slice(-1)
  return `${head}${'*'.repeat(Math.max(name.length - 2, 1))}${tail}`
}

export function formatRevenue(value?: number): string {
  if (value === undefined || value === null) return '-'
  if (value >= 100000000) return `${(value / 100000000).toFixed(2)} 亿`
  if (value >= 10000) return `${(value / 10000).toFixed(2)} 万`
  return value.toLocaleString('zh-CN')
}

export function formatEmployeeCount(value?: number): string {
  if (value === undefined || value === null) return '-'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}
