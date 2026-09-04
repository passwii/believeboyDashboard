/**
 * Token 用量紧凑格式化（AI Chat 展示用）。
 *
 * 设计：
 * - 整数 < 1000 显示完整数字（如 842）。
 * - 1000 ~ 999_499 显示 "1.2k" 形式（保留 1 位小数，去掉末尾 .0）。
 * - 999_500 ~ 999_499_499 显示 "1.2m"。
 * - 更大显示 "1.2b"（十亿级）。
 * - 负数、非有限数统一回退为 "0"。
 * - 非整数输入向下取整（token 统计天然整数）。
 */
export function formatTokenCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0'
  const n = Math.max(0, Math.trunc(value))
  if (n < 1000) return String(n)
  // k 档封顶 999.5k：再大就跳到 m 档，避免显示 "999.5k" 这种几乎触顶的尴尬值
  if (n < 999_500) return compactNumber(n / 1000, 'k')
  if (n < 999_500_000) return compactNumber(n / 1_000_000, 'm')
  return compactNumber(n / 1_000_000_000, 'b')
}

function compactNumber(scaled: number, suffix: string): string {
  const rounded = Math.round(scaled * 10) / 10
  // 1.0k / 1.0m 这种 0 结尾：去 .0；否则保留 1 位小数（如 1.2k）
  const text = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)
  return `${text}${suffix}`
}