/**
 * 国家代码 → 中文站点名 公共映射
 *
 * 覆盖 Amazon 全站点，供前端各模块统一使用。
 * 数据与 auto-reconcile-tab.tsx / email_sender.py 的 _COUNTRY_CN 对齐。
 */

/** 国家代码 → 中文站点名（如 US → '美国站'） */
export const COUNTRY_LABELS: Record<string, string> = {
  US: '美国站',
  DE: '德国站',
  UK: '英国站',
  JP: '日本站',
  FR: '法国站',
  IT: '意大利站',
  ES: '西班牙站',
  CA: '加拿大站',
  MX: '墨西哥站',
  AU: '澳大利亚站',
  IN: '印度站',
  BR: '巴西站',
  NL: '荷兰站',
  SE: '瑞典站',
  PL: '波兰站',
  TR: '土耳其站',
  SG: '新加坡站',
  AE: '阿联酋站',
  BE: '比利时站',
  SA: '沙特站',
}

/**
 * 将国家代码转换为中文站点名。
 * 未知代码原样返回。
 */
export function getCountryLabel(code: string): string {
  return COUNTRY_LABELS[code.toUpperCase()] ?? code
}

/**
 * 将逗号分隔的多国家代码转换为中文站点名列表。
 * 例如 "US,DE" → ["美国站", "德国站"]
 */
export function getCountryLabels(codes: string): string[] {
  return codes
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map(getCountryLabel)
}

/**
 * 将逗号分隔的多国家代码转换为展示字符串。
 * 例如 "US,DE" → "美国站, 德国站"
 */
export function getCountryDisplay(codes: string): string {
  return getCountryLabels(codes).join(', ')
}

/**
 * Select 选项列表，格式为 "美国站 (US)"。
 * 可直接用于 <SelectItem> 渲染。
 */
export const COUNTRY_OPTIONS = Object.entries(COUNTRY_LABELS).map(([value, name]) => ({
  value,
  label: `${name} (${value})`,
}))
