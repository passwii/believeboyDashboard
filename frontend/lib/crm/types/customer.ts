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
