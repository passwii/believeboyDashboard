export type CustomerStatus = 'active' | 'lost' | 'signed' | 'on_hold'
export type CustomerSource = 'referral' | 'exhibition' | 'online_ad' | 'cold_call' | 'other'
export type CustomerRating = 'A' | 'B' | 'C' | 'D'

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
  'id' | 'ownerName' | 'createdAt' | 'updatedAt' | 'createdBy' | 'lastFollowAt' | 'nextFollowAt'
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

export interface CustomerSeaImportResult {
  created: number
  skippedDupes: number
  failed: CustomerSeaImportFailItem[]
}


/** P6a 价值评分部分更新入参（蛇形 key，与后端 ValueScoresUpdate 一致）。 */
export type ValueScoresInput = Partial<
  Record<'score_scale' | 'score_pay' | 'score_fit' | 'score_coop', CustomerRating | null>
>
