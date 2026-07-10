export type CustomerStatus = 'active' | 'lost' | 'signed' | 'on_hold'
export type CustomerSource = 'referral' | 'exhibition' | 'online_ad' | 'cold_call' | 'other'
export type CustomerRating = 'A' | 'B' | 'C' | 'D'

export interface Customer {
 id: string
 name: string
 shortName?: string
 industry?: string
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
}

export type CustomerInput = Omit<
 Customer,
 'id' | 'ownerName' | 'createdAt' | 'updatedAt' | 'createdBy' | 'lastFollowAt'
> & {
 ownerId?: string | null
}