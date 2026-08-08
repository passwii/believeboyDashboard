import type {
  Customer,
  Lead,
  Follow,
  User,
  Contact,
  CustomerInput,
  LeadInput,
  FollowInput,
  FollowEntityType,
  FollowUpGroups,
  ContactInput,
  DashboardStats,
  FunnelStageDetail,
  FunnelStageQuery,
  AuditLog,
  AuditLogQuery,
  CustomerSeaImportRow,
  CustomerSeaImportResult,
  ValueScoresInput,
  Task,
  TaskInput,
  TaskListParams,
  TaskStatus,
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
  updateValueScores(id: string, input: ValueScoresInput): Promise<Customer>
  deleteCustomer(id: string): Promise<void>
  batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void>
  batchMoveToSea(ids: string[]): Promise<void>
  claimFromSea(id: string): Promise<Customer>
  importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult>

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
  listFollowUps(scope?: 'mine' | 'all'): Promise<FollowUpGroups>

  listContacts(customerId: string): Promise<Contact[]>
  createContact(customerId: string, input: ContactInput): Promise<Contact>
  updateContact(id: string, input: ContactInput): Promise<Contact>
  deleteContact(id: string): Promise<void>

  listUsers(): Promise<User[]>
  getUser(id: string): Promise<User>

  getDashboardStats(): Promise<DashboardStats>

  /** 漏斗二层复盘面板：某阶段的停留/卡点明细（BLF-518）。 */
  getFunnelStageDetail(params: FunnelStageQuery): Promise<FunnelStageDetail>

  listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>>

  // ===== Task（P7，BLF-512） =====
  /** 任务列表（scope mine/all + type/status/priority 等白名单筛选）。 */
  listTasks(params: TaskListParams): Promise<Paginated<Task>>
  /** 看板拖拽流转状态（pending/in_progress/done）。 */
  setTaskStatus(id: string, status: TaskStatus): Promise<Task>

  // ===== Task 创建/编辑/完成/取消（P7，BLF-514） =====
  /** 新建任务（owner 默认=当前用户；admin 可指派他人）。 */
  createTask(input: TaskInput): Promise<Task>
  /** 编辑任务（title/description/due_date/priority/type/owner_id）。 */
  updateTask(id: string, input: Partial<TaskInput>): Promise<Task>
  /** 完成：status→done + completed_at。 */
  completeTask(id: string): Promise<Task>
  /** 取消：status→cancelled。 */
  cancelTask(id: string): Promise<Task>
}
