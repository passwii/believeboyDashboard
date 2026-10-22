import type { User } from '@/lib/crm/types'

/** user_accounts.id 是 uuid（36 位，形如 8-4-4-4-12）。 */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * 审计摘要里的 uuid → 用户名（BLF-1440）。
 *
 * 后端 `summarize_update` / `_summarize_task_update` 用字段原值拼摘要，
 * 负责人变更会写成「负责人: <owner_id uuid>→<owner_id uuid>」，详情抽屉的
 * 「操作记录」直接展示就是一串 uuid（用户描述为「像 MD5 的长串」）。
 *
 * 展示层有用户目录（CrmUsersProvider 已全局加载），按 id 还原成姓名即可；
 * 查不到的 id（已删除账号等）原样保留，不丢审计信息。
 */
export function resolveAuditSummary(
  summary: string | null | undefined,
  users: User[]
): string {
  if (!summary) return ''
  if (users.length === 0) return summary
  const nameById = new Map(users.map((u) => [u.id.toLowerCase(), u.name]))
  return summary.replace(
    UUID_PATTERN,
    (id) => nameById.get(id.toLowerCase()) ?? id
  )
}
