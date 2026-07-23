import type {
  Customer,
  Lead,
  Follow,
  User,
  CustomerInput,
  LeadInput,
  FollowInput,
  FollowEntityType,
} from '@/lib/crm/types'

export interface ListParams {
  keyword?: string
  filters?: FilterCondition[]
  scope?: 'mine' | 'all' | 'sea'
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export type FilterCondition =
  | {
      field: string
      op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'between' | 'in' | 'is_null' | 'is_not_null'
      value: unknown
    }
  | { and: FilterCondition[] }
  | { or: FilterCondition[] }

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface CrmClient {
  listCustomers(params: ListParams): Promise<Paginated<Customer>>
  getCustomer(id: string): Promise<Customer>
  createCustomer(input: CustomerInput): Promise<Customer>
  updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer>
  deleteCustomer(id: string): Promise<void>
  batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void>
  batchMoveToSea(ids: string[]): Promise<void>
  claimFromSea(id: string): Promise<Customer>

  listLeads(params: ListParams): Promise<Paginated<Lead>>
  getLead(id: string): Promise<Lead>
  createLead(input: LeadInput): Promise<Lead>
  updateLead(id: string, input: Partial<LeadInput>): Promise<Lead>
  convertLead(
    id: string,
    customerInput?: Partial<CustomerInput>
  ): Promise<{ lead: Lead; customer: Customer }>

  listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]>
  createFollow(input: FollowInput): Promise<Follow>

  listUsers(): Promise<User[]>
  getUser(id: string): Promise<User>
}
