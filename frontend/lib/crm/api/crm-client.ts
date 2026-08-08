import type {
  AuditLog,
  AuditLogQuery,
  Category,
  CategoryInput,
  Customer,
  CustomerSeaImportResult,
  CustomerSeaImportRow,
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
  LifecycleBoard,
  ValueScoresInput,
  Task,
  TaskInput,
  TaskListParams,
  TaskStatus,
  Rule,
  RuleInput,
  WorkflowSettings,
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
  setCustomerCategories(id: string, categoryIds: string[]): Promise<Customer>
  deleteCustomer(id: string): Promise<void>
  batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void>
  batchMoveToSea(ids: string[]): Promise<void>
  claimFromSea(id: string): Promise<Customer>
  importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult>

  listCategories(): Promise<Category[]>
  createCategory(input: CategoryInput): Promise<Category>
  updateCategory(id: string, input: Partial<CategoryInput>): Promise<Category>
  deleteCategory(id: string): Promise<void>

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

  /** 生命周期看板：客户创建 → 首次跟进/转化/流失 的时间分布（BLF-520）。 */
  getLifecycleBoard(): Promise<LifecycleBoard>

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

  // ===== 规则引擎（P9，BLF-543/545） =====
  /** 全部规则列表（含 conditions/actions；admin only，403 由后端 require_admin 兜底）。 */
  listRules(): Promise<Rule[]>
  /** 新建规则（conditions/actions 整体写入）。 */
  createRule(input: RuleInput): Promise<Rule>
  /** 编辑规则（含启停开关 enabled / 条件 / 动作整体替换）。 */
  updateRule(id: number, input: Partial<RuleInput>): Promise<Rule>
  /** 删除规则（CASCADE 子表）。 */
  deleteRule(id: number): Promise<void>

  // ===== P9 工作流自动化设置（BLF-540） =====
  /** 读工作流设置（无跟进提醒阈值/开关）。仅管理员。 */
  getWorkflowSettings(): Promise<WorkflowSettings>
  /** 更新工作流设置（部分更新）。仅管理员。 */
  updateWorkflowSettings(input: Partial<WorkflowSettings>): Promise<WorkflowSettings>
}
