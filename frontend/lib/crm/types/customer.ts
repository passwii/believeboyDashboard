export type CustomerStatus = 'active' | 'lost' | 'signed' | 'on_hold'
export type CustomerSource =
  | 'referral'
  | 'exhibition'
  | 'online_ad'
  | 'cold_call'
  | 'self_developed'
  | 'customer_radar'
  | 'other'
export type CustomerRating = 'A' | 'B' | 'C' | 'D'

/** 客户身上携带的类目摘要（简版：id + name）。 */
export interface CategoryBrief {
  id: string
  name: string
}

export interface Customer {
  id: string
  name: string
  shortName?: string
  industry?: string
  customerType?: string
  interestedService?: string
  rating: CustomerRating
  scoreScale?: CustomerRating | null
  scorePay?: CustomerRating | null
  scoreFit?: CustomerRating | null
  scoreCoop?: CustomerRating | null
  categories: CategoryBrief[]
  status: CustomerStatus
  source: CustomerSource
  ownerId: string | null
  ownerName?: string
  contactName?: string
  contactPhone?: string
  contactEmail?: string
  address?: string
  website?: string
  annualRevenue?: number
  employeeCount?: number
  remark?: string
  createdAt: string
  updatedAt: string
  createdBy: string
  lastFollowAt?: string
  nextFollowAt?: string
}

export type CustomerInput = Omit<
  Customer,
  | 'id'
  | 'ownerName'
  | 'createdAt'
  | 'updatedAt'
  | 'createdBy'
  | 'lastFollowAt'
  | 'nextFollowAt'
  | 'categories'
> & {
  ownerId?: string | null
}


/** 公海批量导入：单行（驼峰，前端态）。 */
export interface CustomerSeaImportRow {
  name: string
  shortName?: string
  industry?: string
  customerType?: string
  interestedService?: string
  rating?: string
  status?: string
  source?: string
  address?: string
  website?: string
  annualRevenue?: number
  employeeCount?: number
  remark?: string
  contactName?: string
  contactPhone?: string
  contactEmail?: string
}

export interface CustomerSeaImportFailItem {
  row: number
  field?: string
  reason: string
}

/** P6b 产品类目（扁平词表，管理员维护）。 */
export interface Category {
  id: string
  name: string
  sortOrder: number
  createdAt: string
}

export type CategoryInput = Pick<Category, 'name'> & { sortOrder?: number }

export interface CustomerSeaImportResult {
  created: number
  skippedDupes: number
  failed: CustomerSeaImportFailItem[]
}


/** P6a 价值评分部分更新入参（蛇形 key，与后端 ValueScoresUpdate 一致）。 */
export type ValueScoresInput = Partial<
  Record<'score_scale' | 'score_pay' | 'score_fit' | 'score_coop', CustomerRating | null>
>
