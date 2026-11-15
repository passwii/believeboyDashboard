/**
 * BLF-1553 · Believeboy LOGO 重设计草稿的三条方向。
 *
 * 三个 mark 都以 `currentColor` 填充，可在浅色 / 暗色 / 钴蓝底上直接换色；
 * `viewBox` 统一为 0 0 64 64，便于在 16~96 px 的既有尺寸槽位里替换。
 * 这些是**草稿**，未接入登录页、侧栏或 favicon；用户确认方向后再替换。
 */

export type BelieveboyMarkDirection = 'wing' | 'ledger' | 'seam'

/**
 * 方向 A · Wing-cut B（推荐）
 *
 * 由既有「B · 飞翼」三片白翼演化：把三片斜切翼收敛成两道向右上扬的切口，
 * 保留 B 的骨架。切口都是斜边，正好落在玻璃边缘的棱角折射带上。
 */
export const WING_CUT_B_PATH =
  'M11.5 6.6 L 46 6.6 L 56.5 17.1 L 55.3 28.7 L 48.9 32 L 55.9 35.3 L 56.5 50.4 L 49.5 57.4 L 11.5 57.4 Z ' +
  'M27.1 12.2 L 42.4 12.2 L 49.5 19.5 L 43 23.1 L 27.1 23.1 Z ' +
  'M27.1 40.9 L 48.7 40.9 L 48.7 51.8 L 27.1 51.8 Z'

/**
 * 方向 B · Ledger B
 *
 * 直边账本 B：每个字怀（counter）里横贯一条细线，把碗形读成「对账行」。
 * 与 V4 Warm Ledger 的账本隐喻同源，但 16 px 下细线会糊，慎用作主标识。
 */
export const LEDGER_B_PATH =
  'M12.5 7 L 50.3 7 L 55.5 12.2 L 55.5 29.6 L 53.3 32 L 55.5 34.4 L 55.5 51.8 L 50.3 57 L 12.5 57 Z ' +
  'M26.9 12.2 L 50.3 12.2 L 50.3 23.4 L 26.9 23.4 Z ' +
  'M26.9 40.6 L 50.3 40.6 L 50.3 51.8 L 26.9 51.8 Z ' +
  'M27.7 17.9 L 49.9 16.5 L 49.9 19.1 L 27.7 20.5 Z ' +
  'M27.7 46.3 L 49.9 44.9 L 49.9 47.5 L 27.7 48.9 Z'

/**
 * 方向 C · Wordmark b
 *
 * 小写 b：字碗圆润，升部顶端斜切成翼尖，适合与 `believeboy` 小写字标组成
 * 「b + elieveboy」的连字锁合。单独作图标时首字母大写语义会丢失。
 */
export const WORDMARK_B_PATH =
  'M21.8 7.2 L 25.2 7.2 L 29.4 10.6 L 29.4 56.8 L 20.6 56.8 L 20.6 8.4 Z ' +
  'M29.4 29.2 L 38.95 29.8 L 52 40.4 L 54.4 43.8 L 50.8 54.4 L 37.1 56.8 L 29.4 56.8 Z ' +
  'M35 35 L 38.95 35.6 L 47 41.8 L 48.8 49.6 L 34.6 51.4 Z'

export const BELIEVEBOY_MARK_PATHS: Record<BelieveboyMarkDirection, string> = {
  wing: WING_CUT_B_PATH,
  ledger: LEDGER_B_PATH,
  seam: WORDMARK_B_PATH,
}

export const BELIEVEBOY_MARK_LABELS: Record<BelieveboyMarkDirection, string> = {
  wing: 'Believeboy · Wing-cut B',
  ledger: 'Believeboy · Ledger B',
  seam: 'Believeboy · Wordmark b',
}

/**
 * `GlassIconReveal` 的 `logo` prop 需要 SVG 标记字符串（它会把 currentColor 换成白色后光栅化）。
 * 这里按方向产出可直接传入的标记。
 */
export function believeboyMarkSvg(direction: BelieveboyMarkDirection = 'wing') {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor">' +
    `<path fill-rule="evenodd" d="${BELIEVEBOY_MARK_PATHS[direction]}"/>` +
    '</svg>'
  )
}
