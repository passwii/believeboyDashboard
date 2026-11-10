/**
 * Warm Ledger 颜色在“无法解析 CSS 变量”的场景（SVG data URL、html-to-image 画布）
 * 需要具体色值。这里从最近的 .warm-ledger 宿主读取已解析主题的 token；
 * 服务端渲染或宿主缺失时回退到暗色 B0 值。
 */
export const WARM_LEDGER_FALLBACK_COLORS = {
  accent: '#e8b35a',
  accentStrong: '#f3c875',
  textSoft: '#c2bbaf',
  textMuted: '#a9a297',
  textFaint: '#837d74',
  chartAxis: '#5f5b55',
  chartGrid: 'rgba(246, 238, 226, 0.09)',
  panel: '#2b2c2b',
  window: '#242525',
} as const

export type WarmLedgerColorName = keyof typeof WARM_LEDGER_FALLBACK_COLORS

const TOKEN_BY_NAME: Record<WarmLedgerColorName, string> = {
  accent: '--warm-ledger-color-accent',
  accentStrong: '--warm-ledger-color-accent-strong',
  textSoft: '--warm-ledger-color-text-soft',
  textMuted: '--warm-ledger-color-text-muted',
  textFaint: '--warm-ledger-color-text-faint',
  chartAxis: '--warm-ledger-color-chart-axis',
  chartGrid: '--warm-ledger-color-chart-grid',
  panel: '--warm-ledger-color-panel',
  window: '--warm-ledger-color-window',
}

/** 读取单个 token 的已解析值；无法解析时返回暗色回退值。 */
export function readWarmLedgerColor(
  name: WarmLedgerColorName,
  host?: Element | null,
): string {
  const fallback = WARM_LEDGER_FALLBACK_COLORS[name]
  if (typeof window === 'undefined') return fallback

  const target = host ?? document.querySelector('.warm-ledger')
  if (!target) return fallback

  const resolved = window.getComputedStyle(target).getPropertyValue(TOKEN_BY_NAME[name]).trim()
  return resolved.length > 0 ? resolved : fallback
}

/** 一次性读取导出 / 截图需要的整组颜色。 */
export function readWarmLedgerColors(
  names: WarmLedgerColorName[],
  host?: Element | null,
): Record<string, string> {
  const read = (name: WarmLedgerColorName) => readWarmLedgerColor(name, host)
  return Object.fromEntries(names.map((name) => [name, read(name)]))
}
