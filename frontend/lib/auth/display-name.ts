/**
 * BLF-1441 · 全局人物显示名解析（前端唯一实现）。
 *
 * 口径（业务方 2026-10-24 定死）：
 *
 * | 情况 | 显示什么 |
 * | --- | --- |
 * | 账号存在 | `user_accounts.full_name`，唯一来源，不回落运营名 / 登录名 |
 * | 账号存在但 `full_name` 为空 | 空（展示端按「未命名」处理），**不**回落登录名 |
 * | 账号不存在（已离职 / 从未建号） | 历史自由文本原样保留，前端不参与解析 |
 *
 * 后端 `LoginResponse` / `MeResponse` 下发 `full_name`，经 NextAuth JWT 落到
 * `session.user.fullName`；请求头 `X-Operator` / `X-User-Name` 与页面展示都从
 * 这里取值，避免各处再写一遍 `operatorNameZh ?? name` 的旧兜底链。
 *
 * ## 为什么还要区分「没有这个键」和「键是 null」
 *
 * `fullName === null` 是后端明确的「这个账号没填姓名」→ 必须显示为空（未命名），
 * 回落登录名就等于把兜底又装回去了。
 *
 * `fullName === undefined` 只有两种来源：**本改动上线前签发的 JWT**（8 小时
 * 会话窗口），或后端还是旧版本、登录响应里没有这个字段。此时回落旧链路
 * （`operatorNameZh → name`）只是过渡：否则升级瞬间所有在线用户的名字变「未命名」、
 * `X-Operator` 头消失，告警 / 订单等强校验接口会直接 401，最长持续 8 小时。
 * 用户重新登录（或 JWT 刷新）后该键必然存在，过渡分支自然失效。
 */

/** 展示端「没有姓名」时的统一文案（账号存在但 full_name 为空）。 */
export const UNNAMED_DISPLAY_NAME = '未命名'

/** 会话里参与显示名解析的字段子集（`Session['user']` 结构上满足它）。 */
export type DisplayNameSource = {
  /** `user_accounts.full_name`；`null` = 后端明确没填，`undefined` = 旧 token / 旧后端。 */
  fullName?: string | null
  /** 历史别名 / 项目匹配键，仅过渡期兜底用。 */
  operatorNameZh?: string | null
  /** 登录名（英文 handle），仅过渡期兜底用。 */
  name?: string | null
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 把后端 `full_name` 归一成「键存在 / 键缺失」两态（BLF-1441）。
 *
 * - `undefined`：响应里根本没有这个字段（前端先上线、后端还是旧版）→
 *   保留 `undefined`，让 `pickSessionDisplayName` 走过渡兜底。
 * - `null` / 空串 / 其它非字符串：后端明确说「这个账号没填姓名」→ 归一成 `null`，
 *   会话里就带着这个 `null`，展示端按「未命名」处理，**不**回落登录名。
 *
 * 两个入口共用它：登录响应（`authorize`）与 `useSession().update()` 的
 * 权威身份回源（`lib/auth/identity-refresh.ts`）。
 */
export function normalizeFullName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 会话里的显示名。返回 `null` 表示「没有可显示的名字」——调用方按场景决定是
 * 显示「未命名」还是不发送 `X-Operator` 头，**不要**在这里回落登录名。
 */
export function pickSessionDisplayName(
  user: DisplayNameSource | null | undefined
): string | null {
  if (!user) return null

  // 键存在（含 null / 空串）→ 以 full_name 为准，不再回落。
  if (user.fullName !== undefined) {
    return trimOrNull(user.fullName)
  }

  // 过渡期：旧 JWT / 旧后端没有这个键。仅此一种情况走旧链路。
  return trimOrNull(user.operatorNameZh) ?? trimOrNull(user.name)
}

/** 展示用文案：有名字用名字，没有就「未命名」。 */
export function formatDisplayName(name: string | null | undefined): string {
  return trimOrNull(name) ?? UNNAMED_DISPLAY_NAME
}
