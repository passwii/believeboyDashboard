import type { ProfileRoleType } from '@/types/profile'

export const ROLE_LABELS: Record<ProfileRoleType, string> = {
  admin: '管理员',
  operator: '运营',
  businessdev: '招商',
  factory: '工厂',
}

export function getRoleLabel(role: ProfileRoleType): string {
  return ROLE_LABELS[role] ?? role
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export type { ProfileRoleType }
