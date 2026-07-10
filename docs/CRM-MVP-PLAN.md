# CRM MVP 实施计划

> 目标：在 `believeboyDashboard` 现有 Next.js 16 + React + shadcn 栈内，以 2 周（约 10 个工作日）交付一个**可演示、可点穿"线索 → 客户"主流程**的 CRM MVP。
> 文档版本：v1.0 · 2026-07-10
> 依赖前置：[`docs/cordys-crm-analysis.md`](./cordys-crm-analysis.md)（CordysCRM 调研与组件清单）
> 工程约定：TDD（测试先于实现，遵循 AGENTS.md"测试先于实现"铁律）

---

## 0. 决策记录（已确认 + 本计划新增）

| # | 决策 | 选项 | 状态 | 备注 |
|---|---|---|---|---|
| D1 | Sidebar 是否独立 | ✅ 独立为 `crm` 组 | 已确认 | — |
| D2 | CRM 组默认可见性 | ✅ **默认全员可见**，子项按 `roles` 过滤 | 已确认 | 非销售角色也能点进 CRM 看聚合视角 |
| D3 | 是否单独 `layout.tsx` | ✅ `app/dashboard/crm/layout.tsx` 必备 | 已确认 | 占位 + 跨页面 Provider 容器 |
| D4 | 数据后端 | ✅ **Mock API（接口先行，可一键切换到真实后端）** | 本计划新增 | 详见 §5 |
| D5 | 自定义字段 | ✅ **MVP 不上**（写死核心字段），接口层留 `FieldDefinition` 抽象 | 本计划新增 | 推迟到 V2 |
| D6 | 公式引擎 | ❌ **MVP 不做** | 本计划新增 | V2+ |
| D7 | 表单设计器 | ❌ **MVP 不做** | 本计划新增 | V2+ |
| D8 | 商机 Kanban | ❌ **MVP 不做**（先做列表视图） | 本计划新增 | 看板拖拽推迟到 V2 |
| D9 | 详情展示形态 | ✅ **右侧 Sheet/Drawer 侧拉**（不走新页面） | 本计划新增 | 沿用 CordysCRM UX 范式 |
| D10 | 主工作台（个人首页） | ❌ **MVP 不做独立 workbench** | 本计划新增 | CRM 根路径直接是客户列表；V2 加 |
| D11 | 状态管理库 | ❌ **不引入新库**；React 局部状态 + URL search params | 本计划新增 | 与现有 `hooks/` 风格一致 |
| D12 | Server cache | ❌ **不引入 React Query/SWR**；自写 `useApi` + 内存缓存（仿 `lib/client-api/profile-client.ts`） | 本计划新增 | 与现有 `lib/client-api/` 风格一致 |
| D13 | 拖拽库 | ✅ `@dnd-kit/core`（V2 Kanban 才装） | 本计划新增 | MVP 不需要 |
| D14 | 测试框架 | ✅ Vitest（已配）+ Playwright（已配） | 沿用 | 单元 + E2E |
| D15 | 国际化 | ❌ **MVP 仅中文**（写死字符串） | 本计划新增 | 后续接入 next-intl 时再抽 `t()` |
| D16 | Toast | ✅ **复用 `components/notifications/useNotifications().notify()`**（项目已有，**不引入 sonner**） | 本计划新增（验证后修正） | 现有通知系统支持 severity/自动消失 |
| D17 | 表单库 | ✅ 新增 `react-hook-form` + `zod` + `shadcn form` 组件 | 本计划新增（验证后修正） | 项目目前未装，Day 0 装上 |
| D18 | 列宽拖拽 | ❌ MVP 不做 | 本计划新增 | 固定宽度即可 |

---

## 1. 目标与非目标

### 1.1 ✅ 目标（DoD · Definition of Done）

交付后能**完整演示**以下 5 个流程，且每个流程都通过 Playwright E2E：

1. **客户管理**：列表（分页/排序/筛选）→ 行点击拉详情 Drawer → 新建/编辑 → 批量转移/移入公海 → 加跟进记录
2. **线索管理**：列表 → 详情 → **转化为客户**（线索转客户是 CRM 销售链路核心闭环）
3. **公海**：把客户扔进公海，其他人可领取
4. **商机**（浅）：仅列表 + 详情，无 Kanban
5. **数据范围**：顶部 Scope 切换（本人 / 全部），列表自动过滤

### 1.2 ❌ 非目标（MVP 不做，明确写出来防止 scope creep）

- 商机 Kanban 拖拽换阶段（D8 推迟到 V2）
- 合同 / 订单 / 回款 / 发票 / 报价
- 自定义字段 / 公式引擎 / 表单设计器（D5-D7）
- 审批流 / 工作流
- BI 仪表板（已有 `components/dashboard/charts.tsx`，V2 接入）
- 个人工作台（V2）
- 标讯抓取
- AI 助手集成
- 移动端 H5 专项优化（响应式做到不崩即可，V2 单独迭代）
- 多语言 i18n（D15）
- 数据权限的"部门/团队"粒度（MVP 仅"本人/全部"两档）

### 1.3 时间盒

- 10 个工作日（2 周） = Phase 0（1d）+ Phase 1（3d）+ Phase 2（3d）+ Phase 3（2d）+ Phase 4（1d buffer）
- Day 0 装依赖（1h，开工前完成，不占 Phase 0 时间盒）
- **若第 9 天还没到 Phase 3 → 砍范围**（先砍商机浅做，保留线索→客户闭环）

---

## 2. 范围

### 2.1 业务域范围

| 域 | 路由 | MVP 深度 | V2 增量 |
|---|---|---|---|
| 客户 Customer | `/dashboard/crm/customers` | **深**（列表+详情+编辑+公海+跟进+批量） | 查重、合并、客户画像 |
| 线索 Lead | `/dashboard/crm/leads` | **深**（列表+详情+编辑+**转客户**+跟进+公海） | 线索池自动分配规则 |
| 商机 Opportunity | `/dashboard/crm/opportunities` | **浅**（列表+详情，仅展示） | Kanban 拖拽、报价单 |
| 公海 Sea | `/dashboard/crm/sea` | **浅**（合并到客户列表的 tab，公海是同一张表的视图过滤） | 独立页 + 自动回收规则 |
| CRM 设置 | `/dashboard/crm/settings` | **不开放**（路由占位 + redirect 到 no-resource） | 自定义字段、阶段、来源 |
| 工作台 Workbench | `/dashboard/crm/workbench` | **不开放**（redirect → /customers） | 个人首页 |

> **「公海」= 客户表的一个视图，不是独立实体**。技术上：客户加 `ownerId: string | null`，`null` 即在公海。这样 MVP 不用建独立表。

### 2.2 组件范围（7 个业务组件）

| # | 组件 | 路径 | 复用度 | 关键依赖 |
|---|---|---|---|---|
| C1 | **crm-table** | `components/crm/crm-table/` | ★★★★★ | `@tanstack/react-table` (已有) + shadcn `Table/Checkbox/Button` |
| C2 | **crm-advance-filter** | `components/crm/crm-advance-filter/` | ★★★★★ | `react-hook-form` + `zod` + `date-fns` (已有) + shadcn `Popover/Select/Input` |
| C3 | **crm-overview-drawer** | `components/crm/crm-overview-drawer/` | ★★★★★ | shadcn `Sheet/Tabs/Badge` |
| C4 | **crm-detail-card** | `components/crm/crm-detail-card/` | ★★★★ | shadcn `Card` |
| C5 | **crm-user-select** | `components/crm/crm-user-select/` | ★★★★ | shadcn `Command/Popover` |
| C6 | **crm-follow-timeline** | `components/crm/crm-follow-timeline/` | ★★★★ | shadcn `ScrollArea` + `lucide-react` icons |
| C7 | **crm-form-create** | `components/crm/crm-form-create/` | ★★★★ | `react-hook-form` + `zod` + shadcn `Form` |

> **V2 追加**：crm-stage-board（Kanban）、crm-batch-actions（拆出）、crm-data-scope-filter（独立组件）、crm-formula、crm-form-design

### 2.3 明确"不重复造"

- 34 个 CordysCRM pure 组件 → **全部用 shadcn 现有**（`components/ui/` 已有 50+）
- 不重做 Sidebar/Header 布局 → 复用 `app/dashboard/layout.tsx`
- 不重做认证 → 复用 `next-auth`（session 来自 `useSession`）
- 不重做项目上下文 → 复用 `lib/project-context.ts`
- 不重做 fetch → 复用 `lib/fetch-with-timeout.ts` + `lib/error-utils.ts`
- 已有 `data-card.tsx / chart.tsx` → V2 BI 仪表板用

---

## 3. 目录与文件骨架（落地后长这样）

```
believeboyDashboard/frontend/
│
├── app/dashboard/crm/                              # ⭐ 新建：CRM 路由（flat）
│   ├── layout.tsx                                  # 必备（D3）：CrmProviders 容器
│   ├── loading.tsx                                 # 全 CRM 范围的 loading skeleton
│   ├── not-found.tsx
│   ├── customers/
│   │   ├── page.tsx                                # 薄壳子（~30 行）调 CrmCustomerTable
│   │   └── loading.tsx
│   ├── leads/
│   │   ├── page.tsx
│   │   └── loading.tsx
│   ├── opportunities/
│   │   ├── page.tsx
│   │   └── loading.tsx
│   ├── sea/
│   │   └── page.tsx                                # V1 = customers 列表的 "公海" tab 视图
│   ├── workbench/
│   │   └── page.tsx                                # V1 = redirect('/dashboard/crm/customers')
│   └── settings/
│       └── page.tsx                                # V1 = redirect 到 no-resource
│
├── components/crm/                                 # ⭐ 新建：跟 components/dashboard/ 平级
│   ├── crm-table/
│   │   ├── index.tsx                               # 主组件
│   │   ├── use-crm-table.ts                        # 表格 hook
│   │   ├── column-builder.ts                       # 列定义工具
│   │   ├── types.ts
│   │   ├── index.test.tsx                          # 单元测试
│   │   └── use-crm-table.test.ts
│   ├── crm-advance-filter/
│   │   ├── index.tsx
│   │   ├── filter-schema.ts                        # zod schema for filter conditions
│   │   ├── predicate-engine.ts                     # 条件求值（=、!=、contains、between、in）
│   │   ├── types.ts
│   │   └── predicate-engine.test.ts
│   ├── crm-overview-drawer/
│   │   ├── index.tsx
│   │   ├── tabs/
│   │   │   ├── detail-tab.tsx
│   │   │   ├── follow-tab.tsx                      # 内部用 crm-follow-timeline
│   │   │   ├── related-tab.tsx                     # 关联商机/合同（MVP 显示空态）
│   │   │   └── log-tab.tsx
│   │   └── types.ts
│   ├── crm-detail-card/
│   │   ├── index.tsx
│   │   ├── field-renderer.tsx                      # 根据 FieldDefinition 渲染（即使 MVP 写死，预留扩展点）
│   │   └── types.ts
│   ├── crm-user-select/
│   │   ├── index.tsx
│   │   └── index.test.tsx
│   ├── crm-follow-timeline/
│   │   ├── index.tsx
│   │   ├── follow-form.tsx                         # 新增跟进的弹窗
│   │   └── types.ts
│   ├── crm-form-create/
│   │   ├── index.tsx
│   │   ├── schemas/                                # 客户/线索各自的 zod schema
│   │   │   ├── customer.schema.ts
│   │   │   └── lead.schema.ts
│   │   └── index.test.tsx
│   └── index.ts                                    # barrel export
│
├── lib/crm/                                        # ⭐ 新建：CRM 共享层
│   ├── sidebar-config-crm.ts                       # 8 个 CRM 菜单项的元数据 + CRM 用 RoleType 角色
│   ├── route-meta.ts                               # CRM 页面 title，复用 DASHBOARD_PAGE_TITLES 风格
│   ├── enums/
│   │   ├── customer.enum.ts                        # 客户状态、来源、行业、等级
│   │   ├── lead.enum.ts                            # 线索状态、来源、意向
│   │   ├── opportunity.enum.ts                     # 阶段、状态
│   │   └── follow.enum.ts                          # 跟进类型（电话/拜访/微信/邮件/备注）
│   ├── types/
│   │   ├── customer.ts
│   │   ├── lead.ts
│   │   ├── opportunity.ts
│   │   ├── follow.ts
│   │   ├── user.ts
│   │   ├── field.ts                                # FieldDefinition 抽象（V2 用）
│   │   └── index.ts
│   ├── method/
│   │   ├── customer-name.ts                        # 客户名脱敏/格式化
│   │   ├── follow-icon.ts                          # 跟进类型 → 图标映射
│   │   └── format.ts
│   └── api/
│       ├── crm-client.ts                           # ⭐ 抽象接口：所有 CRM API 的契约
│       ├── mock-crm-client.ts                      # ⭐ Mock 实现（首期直接用这个）
│       ├── http-crm-client.ts                      # ⭐ 真实后端实现（占位，V1.5 实现）
│       ├── crm-client-provider.tsx                 # ⭐ Context Provider + useCrmClient()
│       ├── mock-data/
│       │   ├── customers.fixture.ts
│       │   ├── leads.fixture.ts
│       │   ├── opportunities.fixture.ts
│       │   ├── follows.fixture.ts
│       │   └── users.fixture.ts
│       └── index.ts
│
├── hooks/                                          # （CRM 专用 hook 直接放这里，不建子目录）
│   ├── use-crm-data-scope.ts                       # 本人/全部 scope 切换（写到 URL search param）
│   ├── use-crm-entity.ts                           # 通用单实体加载 hook（包装 crm-client）
│   ├── use-crm-list.ts                             # 通用列表加载 hook
│   └── use-crm-table.test.ts
│
└── tests/e2e/                                      # 沿用现有 Playwright
    └── crm/
        ├── customer-lifecycle.spec.ts              # 列表 → 详情 → 编辑 → 跟进
        ├── lead-to-customer.spec.ts                # 线索转客户（核心闭环）
        └── sea-flow.spec.ts                        # 客户扔公海 → 领取
```

### 3.1 关键文件样板（让你先看"长什么样"）

**`app/dashboard/crm/customers/page.tsx`（壳子，硬约束 ≤ 50 行）**：

```tsx
'use client'

import { CrmCustomerTable } from '@/components/crm'

export default function CustomersPage() {
  return (
    <div className='h-full p-4'>
      <CrmCustomerTable />
    </div>
  )
}
```

**`app/dashboard/crm/layout.tsx`（Provider 容器）**：

```tsx
'use client'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmDataScopeProvider>
        {children}
      </CrmDataScopeProvider>
    </CrmClientProvider>
  )
}
```

---

## 4. 数据模型（TypeScript 类型）

> MVP 写死字段（**D5**），但接口层用 `FieldDefinition` 抽象保留扩展点。

### 4.1 客户 Customer

```ts
// lib/crm/types/customer.ts
export type CustomerStatus = 'active' | 'lost' | 'signed' | 'on_hold'
export type CustomerSource = 'referral' | 'exhibition' | 'online_ad' | 'cold_call' | 'other'
export type CustomerRating = 'A' | 'B' | 'C' | 'D'

export interface Customer {
  id: string
  name: string                        // 客户名（公司名）
  shortName?: string                  // 简称
  industry?: string                   // 行业
  rating: CustomerRating              // 等级
  status: CustomerStatus
  source: CustomerSource
  ownerId: string | null              // null = 在公海
  ownerName?: string                  // 冗余，避免 N+1
  contactName?: string
  contactPhone?: string
  contactEmail?: string
  address?: string
  website?: string
  annualRevenue?: number              // 预估年营收（元）
  employeeCount?: number              // 公司规模
  remark?: string
  createdAt: string                   // ISO
  updatedAt: string
  createdBy: string
  lastFollowAt?: string               // 冗余，便于"X 天未跟进"规则
  // V2 预留
  // customFields?: Record<string, FieldValue>
}
```

### 4.2 线索 Lead

```ts
// lib/crm/types/lead.ts
export type LeadStatus = 'new' | 'contacting' | 'qualified' | 'converted' | 'discarded'
export type LeadIntent = 'high' | 'medium' | 'low'

export interface Lead {
  id: string
  name: string                        // 联系人名（线索粒度是联系人，不是公司）
  company?: string                    // 所在公司
  phone?: string
  email?: string
  wechat?: string
  source: CustomerSource
  status: LeadStatus
  intent: LeadIntent
  ownerId: string | null              // null = 在线索池
  ownerName?: string
  expectedAmount?: number             // 预期成交金额
  expectedCloseDate?: string
  remark?: string
  createdAt: string
  updatedAt: string
  convertedToCustomerId?: string      // 转化后指向客户 id
  convertedAt?: string
}
```

### 4.3 商机 Opportunity（MVP 浅做，仅展示）

```ts
// lib/crm/types/opportunity.ts
export type OpportunityStage = 'lead_in' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'

export interface Opportunity {
  id: string
  name: string
  customerId: string                  // 关联客户
  customerName?: string               // 冗余
  amount: number
  stage: OpportunityStage
  ownerId: string
  ownerName?: string
  expectedCloseDate?: string
  probability?: number                // 0-100
  remark?: string
  createdAt: string
  updatedAt: string
}
```

### 4.4 跟进记录 Follow

```ts
// lib/crm/types/follow.ts
export type FollowType = 'phone' | 'visit' | 'wechat' | 'email' | 'note'
export type FollowEntityType = 'customer' | 'lead' | 'opportunity'

export interface Follow {
  id: string
  entityType: FollowEntityType
  entityId: string
  type: FollowType
  content: string
  nextFollowAt?: string
  attachments?: Array<{ name: string; url: string }>
  createdBy: string
  createdByName?: string
  createdAt: string
}
```

### 4.5 FieldDefinition 抽象（V2 扩展点）

```ts
// lib/crm/types/field.ts
export type FieldType = 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'textarea' | 'phone' | 'email' | 'url'

export interface FieldDefinition {
  key: string                         // 'name' | 'phone' | 'industry' | ...
  label: string                       // '客户名' | '电话' | ...
  type: FieldType
  required?: boolean
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  group?: 'basic' | 'contact' | 'business' | 'system'  // 用于详情卡片分组
  // V2: roles?, visibleWhen?, formula?
}

// MVP：硬编码字段数组
export const CUSTOMER_FIELDS: FieldDefinition[] = [
  { key: 'name', label: '客户名', type: 'text', required: true, group: 'basic' },
  { key: 'industry', label: '行业', type: 'select', group: 'basic', options: [...] },
  { key: 'rating', label: '等级', type: 'select', required: true, group: 'business', options: [...] },
  // ...
]
```

> 这个 `CUSTOMER_FIELDS` 数组就是 V2 切到"运行时 schema"的迁移入口。MVP 阶段写死在代码里，V2 改成从后端拉。

### 4.6 User

```ts
// lib/crm/types/user.ts
export interface User {
  id: string
  name: string
  email: string
  avatarUrl?: string
  roleType: 'admin' | 'businessdev' | 'operator'
  isActive: boolean
}
```

---

## 5. API 契约（D4 · Mock 先行）

### 5.1 设计原则

- **接口先行**：先定义 TypeScript 接口，所有调用方只依赖接口，不依赖实现
- **可切换**：`CrmClientProvider` 根据 `process.env.NEXT_PUBLIC_CRM_API_MODE` 决定注入 mock 还是 http
- **本地化**：Mock 数据放 `lib/crm/api/mock-data/*.fixture.ts`，**100 条客户 + 50 条线索 + 20 条商机 + 200 条跟进**（够翻页、有性能感）

### 5.2 接口定义

```ts
// lib/crm/api/crm-client.ts
export interface CrmClient {
  // Customer
  listCustomers(params: ListParams): Promise<Paginated<Customer>>
  getCustomer(id: string): Promise<Customer>
  createCustomer(input: CustomerInput): Promise<Customer>
  updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer>
  deleteCustomer(id: string): Promise<void>
  batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void>
  batchMoveToSea(ids: string[]): Promise<void>
  claimFromSea(id: string): Promise<Customer>

  // Lead
  listLeads(params: ListParams): Promise<Paginated<Lead>>
  getLead(id: string): Promise<Lead>
  createLead(input: LeadInput): Promise<Lead>
  updateLead(id: string, input: Partial<LeadInput>): Promise<Lead>
  convertLead(id: string, customerInput?: Partial<CustomerInput>): Promise<{ lead: Lead; customer: Customer }>

  // Opportunity
  listOpportunities(params: ListParams): Promise<Paginated<Opportunity>>
  getOpportunity(id: string): Promise<Opportunity>

  // Follow
  listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]>
  createFollow(input: FollowInput): Promise<Follow>

  // User
  listUsers(): Promise<User[]>
  getUser(id: string): Promise<User>
}

export interface ListParams {
  keyword?: string
  filters?: FilterCondition[]           // 见 §5.3
  scope?: 'mine' | 'all'               // 数据范围
  page?: number                        // 1-based
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
```

### 5.3 筛选条件（与 `crm-advance-filter` 对齐）

```ts
export type FilterCondition =
  | { field: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'between' | 'in' | 'is_null' | 'is_not_null'; value: any }
  | { and: FilterCondition[] }
  | { or: FilterCondition[] }
```

### 5.4 Mock 实现要点

- **延迟模拟**：`fetch-with-timeout` 风格，加 150-400ms 随机延迟，便于看到 loading
- **本地持久化**：用 `localStorage` 存修改（创建/编辑/删除/转移），刷新页面后状态保留
- **乐观更新**：所有 mutation 立即返回，失败回滚（toast 提示）
- **错误注入**：`?crmError=1` 启用 5% 随机失败率（仅 dev）

### 5.5 Provider 选择

```ts
// lib/crm/api/crm-client-provider.tsx
const mode = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'mock'  // 'mock' | 'http'

export function CrmClientProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => mode === 'http' ? new HttpCrmClient() : new MockCrmClient(), [])
  return <CrmClientContext.Provider value={client}>{children}</CrmClientContext.Provider>
}

export const useCrmClient = () => {
  const ctx = useContext(CrmClientContext)
  if (!ctx) throw new Error('useCrmClient must be used within CrmClientProvider')
  return ctx
}
```

### 5.6 真实后端实现（`http-crm-client.ts`）

V1.5 实现，所有方法体抛 `new Error('Not implemented: HTTP CRM client ships in V1.5')`。MVP 期间不调用。

---

## 6. Sidebar & 路由

### 6.1 Sidebar 改动（`lib/sidebar-config.ts`）

在 `SIDEBAR_TOP_GROUPS` 数组**第 2 位**插入（operations 之后、ai 之前）：

```ts
// 1. 在 IconMap 顶部 imports 加：
import { Handshake, Target, Globe, Sparkles, Settings as SettingsIcon, FileText, Users as UsersIcon } from 'lucide-react'

// 2. 在 IconMap 对象加：
const IconMap = {
  // ... 现有的
  Handshake,
  Target,
  Globe,
  SettingsIcon,
  // Users/FileText/Sparkles/Package 可能已存在（按需合并）
}

// 3. 在 SIDEBAR_TOP_GROUPS 第 2 位插入：
{
  id: 'crm',
  label: 'CRM 业务',
  icon: IconMap.Handshake,
  accent: 'bg-[#e5e5e5] text-[#404040] dark:bg-[#2a2a2a] dark:text-[#b0b0b0]',
  activeAccent: 'bg-[#d4d4d4] text-[#262626] dark:bg-[#383838] dark:text-[#e0e0b0]',
  // D2: 不设 groupRoles → 默认全员可见
  items: [
    { title: '客户', url: '/dashboard/crm/customers', icon: IconMap.UsersIcon,
      matchPrefixes: ['/dashboard/crm/customers', '/dashboard/crm/sea'] },
    { title: '线索', url: '/dashboard/crm/leads', icon: IconMap.Sparkles,
      matchPrefixes: ['/dashboard/crm/leads'] },
    { title: '商机', url: '/dashboard/crm/opportunities', icon: IconMap.Target,
      matchPrefixes: ['/dashboard/crm/opportunities'] },
    { title: 'CRM 设置', url: '/dashboard/crm/settings', icon: IconMap.SettingsIcon,
      roles: ['admin'] },  // 仅 admin 可见
  ],
},
```

### 6.2 路由 meta（`lib/dashboard-route-meta.ts`）追加

```ts
{ match: '/dashboard/crm/customers', title: '客户管理' },
{ match: '/dashboard/crm/leads', title: '线索管理' },
{ match: '/dashboard/crm/opportunities', title: '商机管理' },
{ match: '/dashboard/crm/sea', title: '客户公海' },
{ match: '/dashboard/crm/settings', title: 'CRM 设置' },
{ match: '/dashboard/crm', title: 'CRM 业务' },  // 兜底
```

### 6.3 路由页面（详见 §3）

- `/dashboard/crm/workbench` → `redirect('/dashboard/crm/customers')`
- `/dashboard/crm/settings` → `<NoResource />`（D10）
- `/dashboard/crm/sea` → 复用 customer 列表，传 `scope='sea'`（D2 海 = 同一张表 + filter）

---

## 7. Layout & Provider

### 7.1 `app/dashboard/crm/layout.tsx`

```tsx
'use client'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'
import { CrmToastBridge } from '@/components/crm/crm-toast-bridge'  // 见 §9.4

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmDataScopeProvider>
        <CrmToastBridge>
          {children}
        </CrmToastBridge>
      </CrmDataScopeProvider>
    </CrmClientProvider>
  )
}
```

### 7.2 `app/dashboard/crm/loading.tsx`

复用 `components/dashboard/dashboard-page-loading.tsx` 风格，给个简版骨架（3 行 placeholder）。

---

## 8. 组件规格（逐个写清楚）

### C1 · `crm-table` — 通用表格（**最难，先做**）

**Props**：
```ts
interface CrmTableProps<T> {
  // 数据
  queryKey: string                     // 用于缓存 key（如 'customers' | 'leads'）
  fetchPage: (params: ListParams) => Promise<Paginated<T>>
  // 列定义
  columns: CrmColumnDef<T>[]           // 见下方
  // 筛选
  filterFields: FilterFieldDef[]       // 见 crm-advance-filter
  defaultFilters?: FilterCondition[]
  // 行为
  onRowClick?: (row: T) => void
  selectable?: boolean                 // 是否显示 checkbox 列
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  // 视图
  enableViewSave?: boolean             // V1.5 再做
  // 文案
  emptyText?: string
  rowKey: keyof T                      // 'id'
}
```

**CrmColumnDef**（比 shadcn DataTable 多两个能力）：
```ts
interface CrmColumnDef<T> {
  key: keyof T
  title: string
  width?: number
  sortable?: boolean
  filterable?: boolean
  // 渲染器
  render?: (value: T[keyof T], row: T) => React.ReactNode
  // 格式化（兜底 render）
  format?: 'date' | 'datetime' | 'currency' | 'tag' | 'enum'
  enumMap?: Record<string, { label: string; color: string }>
}
```

**行为细节**：
- 加载中：skeleton 行（5 行）
- 加载失败：行内 + 顶部 toast
- 空态：EmptyState 组件（已有 `components/ui/empty-state.tsx`）+ "新建" 按钮
- 排序：列头点击 toggle asc/desc/none
- 分页：底部 `crm-pagination`（MVP 直接用 shadcn `Pagination`，V2 抽）
- 列宽拖拽：**V2 再做**（先固定宽度）
- URL 同步：`page` / `pageSize` / `sortBy` / `sortOrder` / `keyword` / `filters` 全部写到 URL search params（刷新保留、可分享）

**Hook 拆分**（`use-crm-table.ts`）：
- `useCrmTableState()`：URL ↔ state 双向绑定
- `useCrmTableQuery()`：调用 `fetchPage`，TanStack Query 风格的简单 cache（手写，不用 RQ）
- 合并后 `useCrmTable()` 给 `crm-table` 用

**测试**（vitest + @testing-library/react）：
- 列渲染（按 `render` / `format`）
- 排序 toggle
- 选中状态
- 空态
- URL 同步（push / replace）
- 错误态
- 分页

### C2 · `crm-advance-filter` — 高级筛选

**Props**：
```ts
interface CrmAdvanceFilterProps {
  fields: FilterFieldDef[]
  value: FilterCondition[]
  onChange: (next: FilterCondition[]) => void
  storageKey?: string                  // "customer-filter-v1" 存 localStorage
}
interface FilterFieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'dateRange' | 'select' | 'multiselect' | 'user'
  options?: Array<{ label: string; value: string }>
  field?: string                       // 实际数据字段（默认 = key）
}
```

**UI 形态**：
- 触发：右上角"筛选"按钮，badge 显示当前条件数
- 弹出 Popover，宽 600px，3 列布局
- 添加条件：`字段` → `操作符`（根据字段类型）→ `值` → `+` 加一行
- 条件之间用 AND 串联（OR 推迟到 V2）
- 底部：`重置` / `保存为视图（V2）` / `应用`

**`predicate-engine.ts`**：纯函数，给定 `FilterCondition[]` 和 `T[]`，返回 `T[]`。**所有字段类型**都收敛到这一个求值器。

**测试**：
- 每种 op 一组 case（eq/neq/contains/gt/lt/between/in/is_null）
- 嵌套 and/or（MVP 仅支持顶层 AND，但底层要支持）
- 未知字段 → 跳过（不抛错）

### C3 · `crm-overview-drawer` — 详情侧拉

**Props**：
```ts
interface CrmOverviewDrawerProps<T extends { id: string }> {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: FollowEntityType
  entityId: string | null              // null 时显示 loading
  fetchEntity: (id: string) => Promise<T>
  fields: FieldDefinition[]            // 详情字段定义
  tabs: ('detail' | 'follow' | 'related' | 'log')[]  // 默认全开
  onEdit?: (entity: T) => void
  onDelete?: (entity: T) => void
  onTransfer?: (entity: T) => void
  // 上一条/下一条
  enablePagination?: boolean
  currentIndex?: number
  totalCount?: number
  onPrev?: () => void
  onNext?: () => void
}
```

**结构**：
- shadcn `Sheet`（右侧滑出，宽 720px，可拖拽宽度 V2）
- 顶部：实体名 + 状态 badge + 关闭
- Tabs：详情 / 跟进 / 关联（MVP 空态） / 日志（MVP 空态）
- 详情 tab 用 `crm-detail-card` 渲染字段（按 group 分组）
- 跟进 tab 用 `crm-follow-timeline`
- 底部：上一条/下一条 翻页按钮

### C4 · `crm-detail-card` — 字段卡片

**Props**：
```ts
interface CrmDetailCardProps {
  fields: FieldDefinition[]
  values: Record<string, any>
  groupOrder?: Array<'basic' | 'contact' | 'business' | 'system'>
  editable?: boolean                   // V2
}
```

**结构**：4 列网格（label-value 对），按 `group` 分区块标题。

### C5 · `crm-user-select` — 选人

**Props**：
```ts
interface CrmUserSelectProps {
  value: string | null
  onChange: (userId: string | null) => void
  multiple?: boolean
  excludeIds?: string[]                // 转移时排除自己
  placeholder?: string
  size?: 'sm' | 'md'
}
```

**形态**：Combobox（shadcn `Command` + `Popover`），单选 / 多选 tag 模式。

### C6 · `crm-follow-timeline` — 跟进时间线

**Props**：
```ts
interface CrmFollowTimelineProps {
  entityType: FollowEntityType
  entityId: string
  canAdd?: boolean                     // V1 总是 true
}
```

**结构**：
- 顶部"添加跟进"按钮 → 打开 `follow-form.tsx`（Popover 内嵌 form）
- 时间线竖向列表，左侧 icon（按 followType 映射），右侧内容 + 创建人 + 时间

### C7 · `crm-form-create` — 创建/编辑表单

**Props**：
```ts
interface CrmFormCreateProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: 'customer' | 'lead'
  initialValues?: Partial<Customer | Lead>  // 编辑时传
  onSubmit: (values: CustomerInput | LeadInput) => Promise<void>
  mode?: 'create' | 'edit'
  // 线索转客户场景
  presetValues?: Partial<CustomerInput>     // convertLead 时用
  title?: string
}
```

**结构**：
- shadcn `Dialog`（不走 Drawer，因为表单需要全宽 + 滚动）
- 用 `react-hook-form` + `zod` schema（每个 entityType 一个 schema）
- 字段按 `FieldDefinition` 渲染
- 底部：取消 / 保存

**测试**：
- 必填校验
- 提交 loading / 成功 / 失败 toast
- 编辑模式预填值

---

## 9. 状态管理策略

### 9.1 划分原则

| 状态类型 | 位置 | 例 |
|---|---|---|
| **服务器状态**（列表、详情、跟进） | CrmClient + URL search params | `customers?page=2&sortBy=updatedAt` |
| **跨页面状态**（数据范围、选中的客户 ID 列表） | React Context（CrmDataScopeProvider）+ URL | `scope=mine` |
| **页面局部状态**（筛选条件暂存、表单未提交值） | 组件 `useState` | `crm-advance-filter` 内部 |
| **持久化偏好**（表格列宽、视图） | localStorage | V2 |

### 9.2 `useCrmDataScope`（Context + URL）

```ts
// hooks/use-crm-data-scope.ts
type CrmDataScope = 'mine' | 'all'

interface CrmDataScopeContextValue {
  scope: CrmDataScope
  setScope: (s: CrmDataScope) => void
  currentUserId: string                // 从 useSession 拿
}

// 实现：读写 ?scope= 参数，session.user.id 派生
```

### 9.3 URL search params 同步

- 列表分页/排序/筛选/搜索 写到 URL
- 详情用路由（`/customers/c-123`），不用 query string
- 选中的 ID 不写到 URL（Context 即可）

### 9.4 Toast & 错误

- **复用** `components/notifications/useNotifications().notify()`（D16）
- 失败时调用 `notify({ type: 'error', title: '保存失败', message: '...' })`
- 乐观更新失败：notify error + 回滚 UI
- 网络错误：顶部 banner（"网络异常，已显示本地缓存"）

```ts
// 用法示例
import { useNotifications } from '@/components/notifications/notifications-context'
const { notify } = useNotifications()
notify({ type: 'success', title: '客户已创建', message: customer.name })
```

---

## 10. 权限

### 10.1 路由级

- `/dashboard/crm/settings` → `roles: ['admin']`（D2）
- 其它 CRM 路由无路由级限制（默认全员可见）

### 10.2 操作级（"能不能点这个按钮"）

用 `useCurrentUser()` + 简单判断，**不引入 CASL**：

```ts
// lib/crm/method/permission.ts
export function canEditCustomer(user: User, customer: Customer): boolean {
  if (user.roleType === 'admin') return true
  return customer.ownerId === user.id
}
export function canDeleteCustomer(user: User, customer: Customer): boolean {
  return user.roleType === 'admin'
}
export function canClaimFromSea(user: User): boolean {
  return user.roleType !== 'operator'  // 操作员不能领公海
}
```

### 10.3 数据范围

- D2 子集：MVP 仅 `mine | all` 两档
- V2 加 `department` / `department_tree`（需要"我属于哪个部门"数据）

---

## 11. 测试策略

### 11.1 单元测试（Vitest + @testing-library/react）

**必须 100% 覆盖**：
- `predicate-engine.ts`（每种 op + 嵌套 + 边界）
- `crm-table` 的列渲染 / 排序 / 选中 / URL 同步
- `crm-advance-filter` 的 schema 校验
- `permission.ts` 的每个判断函数

**业务组件冒烟测试**（1-2 个 case 即可）：
- `crm-overview-drawer` 打开 / 关闭 / 加载
- `crm-user-select` 选中 / 取消
- `crm-follow-timeline` 添加跟进后出现在列表
- `crm-form-create` 必填校验

**覆盖率门槛**：核心 (`lib/crm/` + `components/crm/`) ≥ 70%（用 `vitest --coverage` 卡线）

### 11.2 E2E（Playwright）

**3 条 happy path**（每条 ≤ 30s）：
1. `customer-lifecycle.spec.ts`：登录 → CRM → 客户列表 → 新建客户 → 点开详情 → 加跟进 → 编辑
2. `lead-to-customer.spec.ts`：登录 → 线索列表 → 新建线索 → 详情 → "转化为客户" → 跳转到新客户详情
3. `sea-flow.spec.ts`：登录 → 客户列表 → 选中 2 个 → 移入公海 → 切到公海 → 领取

**1 条 critical path**：手机端（375px）能打开 CRM 列表不崩

### 11.3 视觉/可访问性

- **不上 Storybook**（项目未配，引入成本高）
- 关键页面用 axe-core 跑一次（Playwright `@axe-core/playwright`）
- Lighthouse 性能分 ≥ 80（客户列表页）

### 11.4 回归保护

- 启动 `pnpm lint` + `pnpm build` 在 CI（已有）
- `pnpm test` 跑通所有 unit
- E2E 在 PR 合并前跑（已有 Playwright workflow？检查 `.github/workflows/`）

---

## 12. 实施顺序（Day-by-Day）

> **铁律**：每个组件先写测试（`*.test.tsx` 红色），再写实现（绿色），最后 refactor。

### Phase 0 · 基础设施（Day 1）

**Day 0 准备（开工前 1h）**：
- [ ] `pnpm add react-hook-form zod @hookform/resolvers`
- [ ] `npx shadcn@latest add form`（自动装 `components/ui/form.tsx`）
- [ ] 验证 `pnpm build` 仍能通过
- [ ] 验证 `useNotifications().notify()` 能在 dev 环境正常弹 toast

| # | 任务 | 估时 | 验收 |
|---|---|---|---|
| 0.1 | Sidebar 改动：加 `crm` group（不含设置入口） | 0.5h | sidebar 出现，hover 出 3 个子项 |
| 0.2 | 路由 meta 追加 6 条 | 0.5h | 切到 `/dashboard/crm/customers` 页面标题正确 |
| 0.3 | 创建 `app/dashboard/crm/layout.tsx`（仅一个空 Provider）+ `loading.tsx` | 0.5h | 路由跳转不报错 |
| 0.4 | 创建所有占位 `page.tsx`（5 个） | 0.5h | 所有 CRM 路由可访问，UI 显示 "Coming soon" |
| 0.5 | `lib/crm/types/` 全套类型定义（§4） | 1h | TS 编译通过 |
| 0.6 | `lib/crm/enums/` 全套枚举 | 0.5h | TS 编译通过 |
| 0.7 | `lib/crm/api/crm-client.ts` 接口 + `mock-crm-client.ts` 空壳 | 1h | 跑通"返回空数组" |
| 0.8 | `crm-client-provider.tsx` + `useCrmClient` | 0.5h | 在 layout 注入，组件内能 `useCrmClient()` |
| 0.9 | `lib/crm/api/mock-data/` 5 个 fixture 文件（手工造数据） | 2h | 100/50/20/200/10 条 |
| 0.10 | `crm-client.ts` 所有方法在 `mock-crm-client.ts` 实现 | 3h | 跑通 list / get / create / update / delete / transfer / moveToSea / claim / convert / listFollows / createFollow / listUsers |
| 0.11 | 提交 `feat(crm): bootstrap` PR | — | 合并 |

**Day 1 结束状态**：所有 CRM 路由可访问（占位页），API 抽象 + mock 全跑通。

### Phase 1 · 核心表格 + 客户列表（Day 2-4）

| # | 任务 | 估时 | 验收 |
|---|---|---|---|
| 1.1 | `crm-table/use-crm-table.ts` 写测试（state、URL 同步） | 1h | 红色 |
| 1.2 | `crm-table/use-crm-table.ts` 实现 | 2h | 绿色 |
| 1.3 | `crm-table/index.tsx` 写测试（渲染、排序、选中） | 2h | 红色 |
| 1.4 | `crm-table/index.tsx` 实现 | 3h | 绿色 |
| 1.5 | `crm-advance-filter/predicate-engine.ts` 写测试 | 1h | 红色 |
| 1.6 | `crm-advance-filter/predicate-engine.ts` 实现 | 1h | 绿色 |
| 1.7 | `crm-advance-filter/index.tsx` 写测试 + 实现 | 3h | 绿色 |
| 1.8 | `crm-table` 与 `crm-advance-filter` 联调测试 | 1h | 筛选/排序/分页 E2E 跑通 |
| 1.9 | `CrmCustomerTable` 组件（拼装） | 2h | 客户列表可看 100 条 |
| 1.10 | 客户列定义（`columns.tsx`） | 1h | 10 列，含状态/等级/负责人/最后跟进 |
| 1.11 | 客户筛选字段定义 | 0.5h | 状态/等级/来源/创建时间/负责人 |
| 1.12 | 接入客户 `page.tsx` | 0.5h | 客户列表页面可访问，真实数据 |
| 1.13 | 数据范围 scope filter（顶部 SegmentedControl） | 1.5h | 切"我的/全部"列表正确过滤 |
| 1.14 | 客户批量勾选 + 工具栏 | 1h | 勾选 / 全选 / 取消 |
| 1.15 | Playwright `customer-lifecycle.spec.ts` 写 50% | 1h | 列表 → 新建可走通 |
| 1.16 | 提交 `feat(crm): customer list` PR | — | 合并 |

**Day 4 结束状态**：客户列表 + 筛选 + 排序 + 批量勾选 + scope 切换可演示。

### Phase 2 · 详情 + 跟进 + 表单（Day 5-7）

| # | 任务 | 估时 | 验收 |
|---|---|---|---|
| 2.1 | `crm-detail-card/index.tsx` 测试 + 实现 | 2h | 字段按组渲染 |
| 2.2 | `crm-user-select/index.tsx` 测试 + 实现 | 1.5h | 选人/取消 |
| 2.3 | `crm-follow-timeline/index.tsx` 实现（无测试，先手动） | 2h | 列表渲染 + 添加 |
| 2.4 | `crm-follow-timeline/follow-form.tsx` 实现 | 1h | 提交后追加到列表 |
| 2.5 | `crm-overview-drawer/index.tsx` 实现 | 3h | 详情 tab + 跟进 tab 显示 |
| 2.6 | `crm-overview-drawer/tabs/detail-tab.tsx` 实现 | 1h | 用 detail-card |
| 2.7 | `crm-overview-drawer/tabs/follow-tab.tsx` 实现 | 1h | 用 follow-timeline |
| 2.8 | `crm-overview-drawer/tabs/related-tab.tsx` 空态 | 0.5h | 显示"暂无关联商机" |
| 2.9 | `crm-overview-drawer/tabs/log-tab.tsx` 空态 | 0.5h | 显示"暂无操作日志" |
| 2.10 | 客户列表行点击 → 打开 drawer | 0.5h | 点击拉详情 |
| 2.11 | `crm-form-create/schemas/customer.schema.ts` | 1h | zod schema |
| 2.12 | `crm-form-create/index.tsx` 测试 + 实现 | 3h | 新建/编辑客户 |
| 2.13 | Drawer 上"编辑"按钮 → 打开 form | 0.5h | 流转通 |
| 2.14 | Playwright `customer-lifecycle.spec.ts` 补全 | 1h | 详情 + 编辑 + 跟进跑通 |
| 2.15 | 提交 `feat(crm): customer detail + form` PR | — | 合并 |

**Day 7 结束状态**：客户全流程（列表 → 详情 → 编辑 → 跟进）可演示。

### Phase 3 · 线索 + 公海 + 商机浅做（Day 8-9）

| # | 任务 | 估时 | 验收 |
|---|---|---|---|
| 3.1 | `CrmLeadTable`（复用 crm-table） | 1h | 线索列表 |
| 3.2 | `CrmLeadOverviewDrawer`（复用 overview-drawer） | 1h | 线索详情 |
| 3.3 | `crm-form-create/schemas/lead.schema.ts` | 0.5h | — |
| 3.4 | 线索新建/编辑 | 1h | 跑通 |
| 3.5 | 线索详情 → "转化为客户"按钮 → 弹 form → 提交 | 3h | 转化后跳新客户 |
| 3.6 | Playwright `lead-to-customer.spec.ts` | 1h | 转化 E2E 跑通 |
| 3.7 | 客户批量"移入公海" | 1h | mock 实现 + UI |
| 3.8 | `/dashboard/crm/sea` 页面（= customer list scope='sea'） | 1h | 公海页可访问 |
| 3.9 | 公海"领取"按钮 | 0.5h | 领取后跳我的客户 |
| 3.10 | Playwright `sea-flow.spec.ts` | 1h | 公海 E2E 跑通 |
| 3.11 | `CrmOpportunityTable`（最简版，10 列） | 1h | 商机列表可看 |
| 3.12 | `CrmOpportunityOverviewDrawer`（只读，无跟进 tab） | 1h | 商机详情 |
| 3.13 | 提交 `feat(crm): lead + sea + opportunity stub` PR | — | 合并 |

**Day 9 结束状态**：线索→客户闭环可演示；公海/商机浅做。

### Phase 4 · 收尾（Day 10）

| # | 任务 | 估时 | 验收 |
|---|---|---|---|
| 4.1 | Mobile 响应式检查（375px / 768px） | 1h | 不崩 |
| 4.2 | Lighthouse 跑客户列表页 | 0.5h | perf ≥ 80 |
| 4.3 | axe-core a11y 跑客户列表 + 详情 | 0.5h | 无 critical issue |
| 4.4 | 空态 / loading / error 状态补全 | 1h | 所有列表/详情都有 |
| 4.5 | `pnpm lint && pnpm build && pnpm test` 跑全 | 0.5h | 全绿 |
| 4.6 | 写一份 `docs/CRM-USER-GUIDE.md`（怎么用 CRM） | 1h | 截图 + 步骤 |
| 4.7 | 更新根 `README.md` 加 CRM 模块说明 | 0.5h | — |
| 4.8 | Demo 录屏（Loom 5 分钟） | 0.5h | 内部展示 |
| 4.9 | 缓冲：补 bug / 收尾 | 3h | — |

**Day 10 结束状态**：MVP 全量可演示、可发布。

---

## 13. 风险 & 缓解

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| `crm-table` 复杂度超预期 | 延期 2-3 天 | 中 | 砍 URL 同步细节，先做 in-memory；V1.1 再加 |
| Mock 数据 100 条性能差 | 表格卡 | 低 | 加分页 / 虚拟滚动（MVP 100 条不需要虚拟滚动） |
| 跟进表单字段太多 | 体验差 | 中 | V1 只支持 4 种跟进类型 + 文本，V2 加附件 |
| Sidebar 7→8 组空间不够 | 视觉挤 | 低 | 60px → 56px 或缩 icon 尺寸（最后手段） |
| next-auth session 字段缺 `id` | crm 操作拿不到 owner | 中 | Day 1 先验证，缺则 Day 1 修 |
| localStorage 在 SSR 报错 | hydration mismatch | 中 | 用 `useEffect` 读 + 初始空数组 |
| TanStack Table v8 API 复杂 | 表格延期 | 中 | Day 2 先做最小可用版（仅 sort + pagination），列宽/拖拽 V2 |
| Zod schema 重复定义（customer / lead） | 维护成本 | 中 | 抽共享 `BaseContactSchema`（phone/email/name 复用） |
| 真实后端接口对不上 | 切换时返工 | 高 | D4：mock 先行，接口文档 V1.5 才出 |
| E2E 不稳定（mock 延迟随机） | CI 飘 | 中 | Mock 延迟改固定 200ms，或 E2E 跑在 mock 模式强制固定 |

---

## 14. 验收清单（DoD · 客观可测）

到第 10 天末，**全部勾选**才能宣称 MVP 完成：

**功能**：
- [ ] 客户列表：100 条 mock 数据，分页/排序/筛选/搜索/批量勾选 正常
- [ ] 客户详情：4 个 tab，详情+跟进可操作，关联/日志显示空态
- [ ] 客户新建/编辑：必填校验、提交后列表刷新
- [ ] 客户批量转移/移入公海：toast 反馈、列表刷新
- [ ] 线索列表/详情/编辑：同上
- [ ] 线索转客户：转化后跳新客户，原线索 status 变 'converted'
- [ ] 公海页：只显示 `ownerId=null` 的客户，可领取
- [ ] 数据范围：本人的只看 `ownerId=currentUserId`，全部看所有
- [ ] 商机列表/详情：可看不可编辑

**工程**：
- [ ] `pnpm lint` 通过
- [ ] `pnpm build` 通过（含 `gen:api-types:check`）
- [ ] `pnpm test` 通过，覆盖率 ≥ 70%
- [ ] 3 条 Playwright E2E 全过
- [ ] 无 console error / warning（除 dev 模式 React DevTools 提示）
- [ ] Lighthouse perf ≥ 80（客户列表页 mobile）
- [ ] axe-core 无 critical a11y issue
- [ ] Mobile 375px 不崩
- [ ] 提交 3-4 个小 PR，commit message 中文 + Conventional Commits

**文档**：
- [ ] `docs/CRM-MVP-PLAN.md`（本文件）已落地
- [ ] `docs/CRM-USER-GUIDE.md`（用户视角）已写
- [ ] 根 `README.md` 提了 CRM 模块

---

## 15. 不在本 MVP 但 V2 必做的清单

> 这些**不是 MVP 失败**，是 V2 的 backlog。先记下避免遗漏。

- crm-stage-board（Kanban 拖拽换阶段）
- crm-batch-actions（独立组件）
- crm-data-scope-filter（独立组件，部门级）
- crm-formula（公式引擎）
- crm-form-design（表单设计器）
- crm-approval / crm-flow（审批流）
- 合同 / 订单 / 报价 / 回款 / 发票
- 商机报价单（quotation）
- 客户公海自动回收规则引擎
- 客户查重 / 合并
- 操作日志（crm-flow 自带，UI 展示）
- 客户画像 / 雷达图
- CRM 范围全局搜索（Cmd+K 已有，扩展数据源）
- 真实后端 API（`http-crm-client.ts` 实现）
- 移动端 H5 专项（<768px 优化）
- 国际化（中/英）
- 数据权限（部门/团队/自定义）

---

## 附录 A：MVP 涉及的 7 个业务组件文件清单

```
components/crm/
├── crm-table/
│   ├── index.tsx                      主组件
│   ├── use-crm-table.ts               hook
│   ├── column-builder.ts              列定义 helper
│   ├── types.ts
│   ├── index.test.tsx
│   └── use-crm-table.test.ts
├── crm-advance-filter/
│   ├── index.tsx
│   ├── filter-schema.ts               zod
│   ├── predicate-engine.ts            纯函数
│   ├── types.ts
│   └── predicate-engine.test.ts
├── crm-overview-drawer/
│   ├── index.tsx
│   ├── tabs/detail-tab.tsx
│   ├── tabs/follow-tab.tsx
│   ├── tabs/related-tab.tsx
│   ├── tabs/log-tab.tsx
│   └── types.ts
├── crm-detail-card/
│   ├── index.tsx
│   ├── field-renderer.tsx
│   └── types.ts
├── crm-user-select/
│   ├── index.tsx
│   └── index.test.tsx
├── crm-follow-timeline/
│   ├── index.tsx
│   ├── follow-form.tsx
│   └── types.ts
├── crm-form-create/
│   ├── index.tsx
│   ├── schemas/customer.schema.ts
│   ├── schemas/lead.schema.ts
│   └── index.test.tsx
└── index.ts
```

## 附录 B：Mock 数据规模

| 实体 | 数量 | 字段填充率 | 备注 |
|---|---|---|---|
| Customer | 100 | 95% | 10 条在公海（ownerId=null），30 条 ownerId=admin，60 条分配给其他 3 个 user |
| Lead | 50 | 90% | 5 条 status='converted'（含 convertedToCustomerId），5 条 status='discarded' |
| Opportunity | 20 | 100% | 关联到 15 个不同客户，5 条 stage='won' |
| Follow | 200 | 100% | 平均每客户 2 条、每线索 1 条、每商机 1.5 条 |
| User | 10 | 100% | 1 admin + 3 businessdev + 6 operator |

## 附录 C：单组件测试覆盖目标

| 组件 | 单元测试 case 数（最少） |
|---|---|
| `useCrmTable` | 8（state init、URL 同步 push/replace、sort toggle、page 变更、filter 合并） |
| `crm-table` 渲染 | 6（加载中、空、错误、选中、排序、分页） |
| `predicate-engine` | 20+（每种 op 2-3 case + 嵌套 + 边界 + 未知字段） |
| `crm-advance-filter` | 4（添加/删除/重置/应用） |
| `crm-user-select` | 3（单选/多选/搜索过滤） |
| `crm-form-create` | 3（必填校验/提交成功/提交失败 toast） |
| `permission.ts` | 8（4 个函数 × 正反 2 case） |
| **合计** | **≥ 50 个 case** |

---

**本计划版本**：v1.0 · 2026-07-10
**作者**：Claude (ZCode)
**下一次同步**：MVP 完成时（预计 2026-07-24）
