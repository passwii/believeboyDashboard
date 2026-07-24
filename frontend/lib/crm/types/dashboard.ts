/** CRM 数据看板统计（P3c，仅管理员可见）。对应后端 GET /crm/dashboard/stats。 */

/** 本月新增（客户 / 线索 / 转化）。 */
export interface NewThisMonth {
  newCustomers: number
  newLeads: number
  convertedCount: number
}

/** 跟进活跃度（最近 7 天）。 */
export interface FollowActivity {
  followCount7d: number
}

/** 每销售业绩（按负责人分组）。 */
export interface OwnerPerformance {
  ownerId: string
  ownerName?: string
  customerCount: number
  convertedThisMonth: number
}

/** 看板聚合结果。 */
export interface DashboardStats {
  /** 线索各状态计数（new/contacting/qualified/converted/discarded）。 */
  leadFunnel: Record<string, number>
  newThisMonth: NewThisMonth
  followActivity: FollowActivity
  perOwner: OwnerPerformance[]
}
