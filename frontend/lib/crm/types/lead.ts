import type { CustomerSource } from './customer'

export type LeadStatus = 'new' | 'contacting' | 'qualified' | 'converted' | 'discarded'
export type LeadIntent = 'high' | 'medium' | 'low'

export interface Lead {
  id: string
  name: string
  company?: string
  phone?: string
  email?: string
  wechat?: string
  source: CustomerSource
  status: LeadStatus
  intent: LeadIntent
  ownerId: string | null
  ownerName?: string
  expectedAmount?: number
  expectedCloseDate?: string
  remark?: string
  createdAt: string
  updatedAt: string
  convertedToCustomerId?: string
  convertedAt?: string
}

export type LeadInput = Omit<
  Lead,
  'id' | 'ownerName' | 'createdAt' | 'updatedAt' | 'convertedToCustomerId' | 'convertedAt'
> & {
  ownerId?: string | null
}
