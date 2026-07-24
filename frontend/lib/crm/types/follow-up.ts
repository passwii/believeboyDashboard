import type { FollowEntityType } from './follow'

/** 一条待跟进记录（客户或线索），按 nextFollowAt 归入逾期/今日/本周。 */
export interface FollowUpItem {
  entityType: FollowEntityType
  entityId: string
  name: string
  /** 线索=公司名；客户=行业 */
  subtitle?: string
  ownerId: string | null
  ownerName?: string
  nextFollowAt: string
  lastFollowContent?: string
  lastFollowAt?: string
  /** 客户等级 */
  rating?: string
  /** 客户状态 / 线索状态 */
  status?: string
  /** 线索意向 */
  intent?: string
}

export interface FollowUpGroups {
  overdue: FollowUpItem[]
  today: FollowUpItem[]
  thisWeek: FollowUpItem[]
  overdueCount: number
  totalCount: number
}
