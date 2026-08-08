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

// ---------- 漏斗二层复盘面板（P8，BLF-518） ----------

/** 阶段明细查询参数（对应后端 GET /crm/dashboard/funnel/stage/{stage}）。 */
export interface FunnelStageQuery {
  stage: string
  /** dwell=按停留时长降序（默认）/ recent=按最后动作倒序。 */
  sortBy?: 'dwell' | 'recent'
  /** 卡点阈值（天），默认 7（与 P9 无跟进提醒阈值一致）。 */
  stuckDays?: number
  page?: number
  pageSize?: number
}

/** 阶段明细里的单条线索（漏斗二层复盘面板用）。 */
export interface StageLeadItem {
  id: string
  name: string
  company?: string
  ownerId: string | null
  ownerName?: string
  source?: string
  intent?: string
  enteredStageAt?: string
  /** 最后动作时间 = 最近一条跟进；无跟进为 undefined。 */
  lastActionAt?: string
  /** 最近一条跟进内容（面板展示，前端截断）。 */
  lastActionContent?: string
  nextFollowAt?: string
  /** 停留天数（可能为小数，前端取整展示）。 */
  dwellDays?: number
  /** 停留 > stuckDays 即视为卡住。 */
  isStuck: boolean
}

/** 某阶段的复盘明细（漏斗二层面板）。 */
export interface FunnelStageDetail {
  stage: string
  /** 当前处于该阶段的线索数（未删除）。 */
  count: number
  /** 平均停留天数（无数据为 undefined）。 */
  avgDwellDays?: number
  /** 停留 > stuckDays 的条数。 */
  stuckCount: number
  /** 本期流入；无时间范围 = 全部成员。 */
  inflow: number
  /** 本期流失（近似）；无时间范围为 undefined。 */
  outflow?: number
  stuckDays: number
  leads: StageLeadItem[]
  page: number
  pageSize: number
  total: number
}
