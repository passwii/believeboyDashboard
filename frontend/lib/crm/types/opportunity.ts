export type OpportunityStage = 'lead_in' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'

export interface Opportunity {
  id: string
  name: string
  customerId: string
  customerName?: string
  amount: number
  stage: OpportunityStage
  ownerId: string
  ownerName?: string
  expectedCloseDate?: string
  probability?: number
  remark?: string
  createdAt: string
  updatedAt: string
}

export type OpportunityInput = Omit<
  Opportunity,
  'id' | 'customerName' | 'ownerName' | 'createdAt' | 'updatedAt' | 'ownerId'
> & {
  ownerId?: string | null
}
