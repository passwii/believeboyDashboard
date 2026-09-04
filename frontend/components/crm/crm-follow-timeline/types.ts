import type { Follow, FollowInput, FollowType, FollowEntityType } from '@/lib/crm/types/follow'

export interface CrmFollowTimelineProps {
  entityType: FollowEntityType
  entityId: string
  /** 已有跟进记录（由父级从 listFollows 加载） */
  follows: Follow[]
  /** 是否加载中 */
  loading?: boolean
  /** 提交跟进回调（父级调 createFollow 并刷新） */
  onSubmit: (input: Omit<FollowInput, 'entityType' | 'entityId' | 'createdBy'>) => void | Promise<void>
  /** 允许的跟进类型；默认全部 */
  allowedTypes?: FollowType[]
}

export interface FollowFormValue {
  type: FollowType
  content: string
  nextFollowAt?: string
}
