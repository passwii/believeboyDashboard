import type { FollowType } from '@/lib/crm/types/follow'

export const FOLLOW_TYPE_LABELS: Record<FollowType, string> = {
 phone: '电话沟通',
 visit: '上门拜访',
 wechat: '微信沟通',
 email: '邮件沟通',
 note: '备注',
}