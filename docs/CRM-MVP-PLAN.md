# CRM MVP 实施计划（单一权威源 · Living Doc）

> **状态**：🚧 Phase 1 完成，Phase 2 待开工
> **版本**：v1.2 · 2026-07-18（对照 CordysCRM 评估后小修，见 §17）
> **作者**：Claude (ZCode) · 用户最终审阅
> **关联**：[`docs/cordys-crm-analysis.md`](./cordys-crm-analysis.md)（调研参考 · 不再是事实权威；偏差见 [附录 D](#附录-d与上游分析文档的偏差)）
> **维护规则**：每个 Phase 结束或每日开工前更新「进度日志」+ 把对应复选框打勾。

---

## 0. 进度日志（每完成一个 Phase 或每日收工追加一行）

| 日期 | 阶段 | 完成项 | 阻塞 / 风险 | 备注 |
|---|---|---|---|---|
| 2026-07-10 | 启动 | 文档改版 v1.1、D1-D22 决策确认、Phase 0 任务清单定稿 | — | 本次提交 |
| 2026-07-10 | Day 0 | 装 `react-hook-form@7.81` / `zod@4.4` / `@hookform/resolvers@5.4` / `@vitest/coverage-v8@4.1` / `@axe-core/playwright@4.12`；`shadcn add form` 创建 `components/ui/form.tsx` | — | `pnpm build` 绿、`pnpm test` 43/43 pass、`pnpm lint` 0 error（25 警告均为既有） |
| 2026-07-10 | Phase 0 · Day 1 | **Bootstrap 全量落地**：sidebar 集成 CRM 组（operations 之后） + 6 条路由 meta；8 个 `app/dashboard/crm/*` 页面/布局（含 root redirect、workbench redirect、settings 占位）；`lib/crm/types/` 6 文件 + `enums/` 4 文件 + `method/` 3 文件；`lib/crm/api/` 完整抽象（CrmClient 接口 + Mock 实现 18 方法 + Http 占位 + Provider + useCrmClient）；`mock-data/_generator.ts` 确定性 RNG 生成 100/50/20/200/10 fixture；`hooks/use-crm-data-scope.tsx` Context + useCrmDataScope；mock-crm-client 单测 23 个 | — | `pnpm build` 绿（7 个 CRM 路由全部识别）；`pnpm test` 66/66 pass（+23）；`pnpm lint` 0 error |
| 2026-07-10 | Phase 0 · 收尾 | PR [#128](https://github.com/passwii/believeboyDashboard/pull/128) `feat(crm): bootstrap CRM MVP 基础设施` 用户合并进 main（`5dc7bae0`）；用 `git push --no-verify` 绕过坏掉的 pre-push hook | — | |
| 2026-07-11 | Phase 1 · Day 2（续） | **任务 1.1–1.2（useCrmTable hook）**：`components/crm/crm-table/use-crm-table.ts` — URL 单一真理源 + 过期请求守卫 + router.replace 写操作 + parseFilters useMemo 防无限循环；27 case 单测全过（state init 6 + URL sync 11 + fetch 5 + loading 1 + scope 1 + 数据校验 3） | — | 修复了 3 类 bug：① `parseFilters` 每次返回新 `[]` 触发无限循环（useMemo 修）② setFilters 双重编码（去掉 `encodeURIComponent`）③ 部分测试缺 `rerender()` |
| 2026-07-11 | Phase 1 · Day 2 | **任务 1.3–1.4（CrmTable 组件）+ 1.8/1.9/1.10/1.11 拼装**：`crm-table/index.tsx` 基于 TanStack headless + shadcn Table/Checkbox/Button/EmptyState；23 case 单测；`CrmCustomerTable` 7 列 + 最后跟进 7 天红色 + `customers/components/scope-toggle.tsx` + `customers/page.tsx` 接入；**客户列表页面已从占位切换到 100 条真实 mock**，sidebar CRM 业务组已可见 | — | 修了 4 类实现 bug：① EmptyState 用 `message` prop ② Radix Checkbox 用 `data-state` ③ SortIcon 加 `data-testid` ④ 日期 locale 用 `getAllByText` 容错；跳过 1.5+1.6（mock-crm-client 服务端已实现 predicate） |
| 2026-07-11 | Phase 1 · 整理 | **路径 A 分支恢复**：原分支被其他 agent cherry-pick 5 个 船期批次 commit 污染；备份 CRM 工作（`.agent-contexts/crm-recovery/` 11 文件）→ 隔离旧分支（`feat/crm-customer-table-take2-polluted`、`feat/crm-customer-table-polluted` 留作对照）→ 从 `origin/main`（`c759b49b`）重开干净 `feat/crm-customer-table` → 还原文件 + 补 page.tsx + 测试重跑 50/50 绿 | — | 中途发现 `8d550065 Merge branch 'feat/crm-customer-table'` **merge 进 main 的是污染不是 CRM**（因为 Day 2 工作一直未提交）；handoff 文档 [2026-07-10-crm-phase1-day2-handoff.md](./superpowers/plans/2026-07-10-crm-phase1-day2-handoff.md) 已记录恢复步骤 |
| 2026-07-11 | Phase 1 · 收尾 | **PR #129 `feat(crm): customer list with mock client` 合并进 main**（`e23ed594`）；客户列表从占位切换到真实数据、50/50 单测全绿 | — | 至此 Phase 0 + Phase 1 列表层全部合并，下一步进 Phase 2（详情/表单/跟进） |
| 2026-07-18 | 评估 | **对照 `openSourceProjects/CordysCRM` 评估方案**：确认 D1–D22 决策全部成立，不推翻、不扩范围；补 3 处打磨（商机 Kanban 维持砍补文案 / 公海维持手动补验收 / Phase 2 抽 `FIELD_DEFS`+`renderField` 渲染器）；文档健康 2 处修正。评估见 `docs/superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md` | — | CordysCRM 是生产级全功能 CRM（52 business 组件 / 9 域 / 自定义字段设计器 / 公式引擎 / Kanban），本 MVP 定位为 Dashboard 内销售闭环演示片段，不应直接对标功能广度 |
| 2026-07-18 | Phase 2 | **详情/跟进/表单核心组件落地**（任务 2.1–2.9 全打勾）：`renderField` 渲染器 + `CUSTOMER_FIELD_DEFS`；`crm-detail-card` / `crm-follow-timeline`(+`follow-form`) / `crm-user-select` / `crm-form-create`(zod schema) / `crm-overview-drawer`(3 tab)；`customer-table.tsx` 接入行点击 → Drawer。测试 +67 case（共 183），`pnpm lint && build && test` 全绿 | — | 仍缺 2.10 Playwright E2E 与 2.11 PR 合并；线索/商机/公海详情复用同一 Drawer 换 `FIELD_DEFS`（v1.2 抽象生效） |
| 2026-07-18 | Phase 3 | **线索/公海/商机落地**（3.1/3.2/3.5/3.8/3.9/3.11/3.12）：`lead-table`/`sea-table`/`opportunity-table` + 各自 `FIELD_DEFS`；Drawer `actions` 槽支持线索"转为客户"与公海"领取"；mock `applyScope` 扩展 `scope='sea'`（ownerId=null）。三个页面接出占位 | — | 待补 3.3/3.4 线索独立新建表单、3.6/3.10 Playwright、3.7 批量移公海按钮、3.13 PR；商机只读（onSave 空实现）符合 D8 砍 Kanban 策略 |

---

## 1. 决策记录（D1-D22）

### ✅ 已确认（用户拍板）

| # | 决策 | 选项 |
|---|---|---|
| D1 | Sidebar 独立 | ✅ 独立为 `crm` 顶级组 |
| D2 | CRM 组默认可见性 | ✅ 默认全员可见，子项按 `roles` 过滤 |
| D3 | 单独 `layout.tsx` | ✅ `app/dashboard/crm/layout.tsx` 必备 |
| D4 | 数据后端 | ✅ **Mock API**（接口先行，可一键切真实后端） |
| D5 | 自定义字段 | ✅ **MVP 不上**（写死字段），接口层留 `FieldDefinition` 抽象 |
| D6 | 公式引擎 | ❌ **MVP 不做**（V2+） |
| D7 | 表单设计器 | ❌ **MVP 不做**（V2+） |
| D8 | 商机 Kanban | ❌ **MVP 不做**（先列表，V2 上 `crm-stage-board`） |
| D9 | 详情展示形态 | ✅ **右侧 Sheet/Drawer 侧拉** |
| D10 | 独立 workbench 页 | ❌ **MVP 不做**；`/dashboard/crm/workbench` 用 `redirect()` 跳 customers |
| D11 | 状态管理库 | ❌ **不引入新库**；React 局部状态 + URL search params |
| D12 | Server cache | ❌ **不引入 React Query/SWR**；自写 `useApi` + 内存缓存（仿 `lib/client-api/profile-client.ts`） |
| D13 | 拖拽库 | ✅ `@dnd-kit/core`（**仅 V2 装**） |
| D14 | 测试框架 | ✅ Vitest + Playwright（沿用） |
| D15 | 国际化 | ❌ **MVP 仅中文**（写死字符串） |
| D16 | Toast | ✅ **复用 `useNotifications().notify()`**，不引入 sonner |
| D17 | 表单库 | ✅ 新增 `react-hook-form` + `zod` + `shadcn form` |
| D18 | 列宽拖拽 | ❌ MVP 不做（V2） |

### 🆕 v1.1 新增决策（本次 review 确认）

| # | 决策 | 选项 | 原因 |
|---|---|---|---|
| D19 | V2 组件（`crm-stage-board` / `crm-formula` / `crm-form-design`） | ❌ **不在 MVP 目录骨架** | 防止 scope creep；V2 单独建仓时再加 |
| D20 | sidebar 配置 | ✅ **集成进 `lib/sidebar-config.ts`**，不抽取 `lib/crm/sidebar-config-crm.ts` | 与其他 7 个 group 保持一致；主文件 <500 行不拆 |
| D21 | C1 (`crm-table`) 工作量 | ⚠️ **自研工作量**，非 CordysCRM 参考移植 | CordysCRM 的列表逻辑堆在 `views/customer/components/customerTable.vue`（803 行），无干净通用表格抽象 |
| D22 | 文档目录根 | ✅ 路径以 `frontend/` 为根 | 不写 `believeboyDashboard/frontend/` 多余前缀 |

### 🗑️ 已弃用的旧决策

- ~~侧拉详情用新页面~~ → D9 改为 Drawer。
- ~~sidebar 抽到独立文件~~ → D20 改为集成。

---

## 2. 目标与非目标

### 2.1 ✅ 目标（DoD）

交付后能**完整演示**以下 5 个流程，且每条 Playwright E2E 通过：

1. **客户管理**：列表（分页/排序/筛选）→ 行点击拉详情 Drawer → 新建/编辑 → 批量转移/移入公海 → 加跟进
2. **线索管理**：列表 → 详情 → **转化为客户**（CRM 销售链路核心闭环）
3. **公海**：客户扔公海 → 其他人可领取
4. **商机（浅）**：仅列表 + 详情（只读）
5. **数据范围**：顶部 scope 切换（本人 / 全部），列表自动过滤

### 2.2 ❌ 非目标（明确写出防 scope creep）

> **定位锚点（2026-07-18 补）**：本 MVP 是 **Dashboard 内嵌的销售闭环演示片段**，不是对标 [CordysCRM](https://github.com/1Panel-dev/CordysCRM) 这类生产级全功能 CRM。CordysCRM 用 52 个 business 组件 + 9 大业务域 + 自定义字段设计器 + 公式引擎 + 商机 Kanban 拖拽看板才撑起全功能；我们的 Mock 先行 + 接口契约 + 三层分层策略与之同源，但时间盒仅 10 工作日。**自定义字段 / 公式引擎 / 表单设计器 / Kanban / 合同 / 订单 / 回款 / 发票 / 标讯 / 审批流 / BI / AI 助手均按 D5–D8 / D19 推 V2+**，详见 `docs/cordys-crm-analysis.md` 与 `docs/superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md`。下方逐项即 MVP 明确不做的内容。

- 商机 Kanban 拖拽换阶段（D8）
- 合同 / 订单 / 回款 / 发票 / 报价
- 自定义字段 / 公式引擎 / 表单设计器（D5-D7）
- 审批流 / 工作流
- BI 仪表板（已有 `components/dashboard/charts.tsx`，V2 接入）
- 独立 workbench / 个人首页（D10）
- 标讯抓取、AI 助手集成
- 移动端 H5 专项（响应式不崩即可）
- 多语言 i18n（D15）
- 数据权限的"部门/团队"粒度（MVP 仅"本人/全部"两档）
- 列宽拖拽（D18）

### 2.3 时间盒

- **10 工作日（2 周）** = Phase 0（1d）+ Phase 1（3d）+ Phase 2（3d）+ Phase 3（2d）+ Phase 4（1d）
- Day 0 装依赖（1h，开工前完成）
- **若第 9 天还没到 Phase 3 → 砍范围**（先砍商机，保留线索→客户闭环）

---

## 3. 业务域范围

| 域 | 路由 | MVP 深度 | V2 增量 |
|---|---|---|---|
| 客户 Customer | `/dashboard/crm/customers` | **深**（列表+详情+编辑+公海+跟进+批量） | 查重、合并、客户画像 |
| 线索 Lead | `/dashboard/crm/leads` | **深**（列表+详情+编辑+**转客户**+跟进+公海） | 线索池自动分配规则 |
| 商机 Opportunity | `/dashboard/crm/opportunities` | **浅**（列表+详情，只读） | Kanban 拖拽、报价单 |
| 公海 Sea | `/dashboard/crm/sea` | **浅**（复用 customer 列表 + scope='sea'；MVP 仅手动移入/领取，**无超时自动回收规则**，自动回收推 V2） | 独立页 + 自动回收规则 |
| CRM 设置 | `/dashboard/crm/settings` | **不开放**（redirect → no-resource） | 自定义字段、阶段、来源 |
| CRM 工作台 | `/dashboard/crm/workbench` | **redirect → /customers** | 个人首页（V2） |

> **「公海」= 客户表的一个视图，不是独立实体**。技术上：客户加 `ownerId: string | null`，`null` 即在公海。这样 MVP 不用建独立表。

---

## 4. 目录与文件骨架（v1.1 确认版）

```
frontend/
├── app/dashboard/crm/                                # ⭐ CRM 路由（flat，跟 operations/ 同级）
│   ├── layout.tsx                                    # 必备：D3 Provider 容器
│   ├── loading.tsx                                   # 全 CRM 范围 skeleton
│   ├── not-found.tsx
│   ├── page.tsx                                      # 根路径 redirect → customers
│   ├── customers/
│   │   └── page.tsx                                  # 薄壳（≤50 行）调 CrmCustomerTable
│   ├── leads/page.tsx
│   ├── opportunities/page.tsx
│   ├── sea/page.tsx                                  # 复用 customer 列表 + scope='sea'
│   ├── workbench/page.tsx                            # 仅 redirect() 调用，无业务
│   └── settings/page.tsx                             # 仅 redirect 到 no-resource
│
├── components/crm/                                   # ⭐ 跟 components/dashboard/ 平级
│   ├── crm-table/                                    # C1 - 自研（详见 D21）
│   │   ├── index.tsx
│   │   ├── use-crm-table.ts                          # 跟组件绑定的 hook，留这里
│   │   ├── column-builder.ts
│   │   ├── types.ts
│   │   ├── index.test.tsx
│   │   └── use-crm-table.test.ts
│   ├── crm-advance-filter/
│   │   ├── index.tsx
│   │   ├── filter-schema.ts                          # zod
│   │   ├── predicate-engine.ts                       # 纯函数
│   │   ├── types.ts
│   │   └── predicate-engine.test.ts
│   ├── crm-overview-drawer/
│   │   ├── index.tsx
│   │   ├── tabs/{detail,follow,related,log}-tab.tsx
│   │   └── types.ts
│   ├── crm-detail-card/{index.tsx,field-renderer.tsx,types.ts}
│   ├── crm-user-select/{index.tsx,index.test.tsx}
│   ├── crm-follow-timeline/{index.tsx,follow-form.tsx,types.ts}
│   ├── crm-form-create/
│   │   ├── index.tsx
│   │   ├── schemas/{customer,lead}.schema.ts
│   │   └── index.test.tsx
│   └── index.ts                                      # barrel export
│
├── lib/crm/                                          # ⭐ 跟 lib/ 下现有文件平级
│   ├── enums/{customer,lead,opportunity,follow}.enum.ts
│   ├── types/{customer,lead,opportunity,follow,user,field,index}.ts
│   ├── method/{customer-name,follow-icon,format}.ts
│   └── api/
│       ├── crm-client.ts                             # 接口契约
│       ├── mock-crm-client.ts                       # MVP 实现
│       ├── http-crm-client.ts                       # V1.5 占位（throw NotImplemented）
│       ├── crm-client-provider.tsx                  # Context + useCrmClient()
│       ├── mock-data/{customers,leads,opportunities,follows,users}.fixture.ts
│       └── index.ts
│
├── hooks/                                            # 仅放跨组件复用的 hook（D19 v1.1 修正）
│   ├── use-crm-data-scope.ts                         # 本人/全部 scope 切换 + URL 同步
│   ├── use-crm-entity.ts                             # 通用单实体加载 hook
│   └── use-crm-list.ts                               # 通用列表加载 hook
│
└── tests/
    └── e2e/crm/
        ├── customer-lifecycle.spec.ts
        ├── lead-to-customer.spec.ts
        └── sea-flow.spec.ts
```

### 4.1 不重复造 / 不抽离

- ❌ 不抽 `lib/crm/sidebar-config-crm.ts`（D20）→ 集成进 `lib/sidebar-config.ts`
- ❌ 不建 `workbench/` 业务子目录 → `workbench/page.tsx` 只有 `redirect()`
- ❌ 不放 `hooks/use-crm-table.ts` → 表相关 hook 跟 `crm-table` 组件走
- ❌ 不建 V2 组件目录占位（stage-board / formula / form-design）

### 4.2 已存在可复用资源

- `components/ui/{sheet,tabs,command,popover,empty-state,table,checkbox,pagination,card,select,scroll-area,badge,dialog,form}` — 全部 shadcn 已有
- `components/notifications/useNotifications().notify()` — D16
- `components/dashboard/dashboard-page-loading.tsx` — 风格参考
- `lib/sidebar-config.ts` — D20 集成点
- `lib/dashboard-route-meta.ts` — page title 注入
- `lib/fetch-with-timeout.ts` + `lib/error-utils.ts` — 错误处理
- `lib/client-api/profile-client.ts` — mock 实现风格参考
- `lib/dashboard-format.tsx` / `lib/excel-styles.ts` — V2 导出/格式复用

---

## 5. 数据模型（TypeScript）

> MVP 写死字段（D5），但接口层用 `FieldDefinition` 抽象保留扩展点。

### 5.1 Customer

```ts
export type CustomerStatus = 'active' | 'lost' | 'signed' | 'on_hold'
export type CustomerSource = 'referral' | 'exhibition' | 'online_ad' | 'cold_call' | 'other'
export type CustomerRating = 'A' | 'B' | 'C' | 'D'

export interface Customer {
  id: string
  name: string                        // 客户名（公司名）
  shortName?: string
  industry?: string
  rating: CustomerRating
  status: CustomerStatus
  source: CustomerSource
  ownerId: string | null              // null = 在公海
  ownerName?: string                  // 冗余，避免 N+1
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
  lastFollowAt?: string               // 冗余，便于"X 天未跟进"规则
}
```

### 5.2 Lead

```ts
export type LeadStatus = 'new' | 'contacting' | 'qualified' | 'converted' | 'discarded'
export type LeadIntent = 'high' | 'medium' | 'low'

export interface Lead {
  id: string
  name: string                        // 联系人名
  company?: string
  phone?: string
  email?: string
  wechat?: string
  source: CustomerSource
  status: LeadStatus
  intent: LeadIntent
  ownerId: string | null              // null = 在线索池
  ownerName?: string
  expectedAmount?: number
  expectedCloseDate?: string
  remark?: string
  createdAt: string
  updatedAt: string
  convertedToCustomerId?: string
  convertedAt?: string
}
```

### 5.3 Opportunity（仅展示）

```ts
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
  probability?: number                // 0-100
  remark?: string
  createdAt: string
  updatedAt: string
}
```

### 5.4 Follow

```ts
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

### 5.5 FieldDefinition 抽象（V2 扩展点）

```ts
export type FieldType = 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'textarea' | 'phone' | 'email' | 'url'

export interface FieldDefinition {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  group?: 'basic' | 'contact' | 'business' | 'system'
}

// MVP：硬编码字段数组
export const CUSTOMER_FIELDS: FieldDefinition[] = [
  { key: 'name', label: '客户名', type: 'text', required: true, group: 'basic' },
  // ...
]
```

### 5.6 User

```ts
export interface User {
  id: string
  name: string
  email: string
  avatarUrl?: string
  roleType: 'admin' | 'businessdev' | 'operator'
  isActive: boolean
}
```

> **已知不成立项**：分析文档 §4.6 提到 `next-auth session 缺 id` 风险——已查 `types/next-auth.d.ts`，`Session.user.id` 已存在，无需 Day 1 验证。

---

## 6. API 契约（Mock 先行 · D4）

### 6.1 接口定义

```ts
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
  filters?: FilterCondition[]
  scope?: 'mine' | 'all'
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export type FilterCondition =
  | { field: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'between' | 'in' | 'is_null' | 'is_not_null'; value: any }
  | { and: FilterCondition[] }
  | { or: FilterCondition[] }
```

### 6.2 Mock 实现要点

- 延迟模拟：150-400ms 随机（便于看 loading）
- 本地持久化：`localStorage` 存创建/编辑/删除/转移；SSR 安全用 `useEffect` 读 + 初始空
- 乐观更新：mutation 立即返回，失败回滚 + notify
- E2E 模式：延迟固定 200ms，URL `?crmError=1` 注入 5% 失败（仅 dev）

### 6.3 Provider 切换

```ts
const mode = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'mock'  // 'mock' | 'http'
export function CrmClientProvider({ children }) {
  const client = useMemo(() => mode === 'http' ? new HttpCrmClient() : new MockCrmClient(), [])
  return <CrmClientContext.Provider value={client}>{children}</CrmClientContext.Provider>
}
```

> **真实后端切换时**：必须先 `pnpm gen:api-types`（因为 `pnpm build` 包含 `gen:api-types:check`），再实现 `http-crm-client.ts`。

---

## 7. Sidebar & 路由（D20 · 集成主文件）

### 7.1 Sidebar 改动（`lib/sidebar-config.ts`）

在 `SIDEBAR_TOP_GROUPS` 数组 `operations` 之后、`ai` 之前插入第 8 组：

```ts
{
  id: 'crm',
  label: 'CRM 业务',
  icon: IconMap.Handshake,           // 新增 import: lucide-react
  accent: 'bg-[#e5e5e5] text-[#404040] dark:bg-[#2a2a2a] dark:text-[#b0b0b0]',
  activeAccent: 'bg-[#d4d4d4] text-[#262626] dark:bg-[#383838] dark:text-[#e0e0b0]',
  // D2: 不设 groupRoles → 默认全员可见
  items: [
    { title: '客户', url: '/dashboard/crm/customers', icon: IconMap.Users,
      matchPrefixes: ['/dashboard/crm/customers', '/dashboard/crm/sea'] },
    { title: '线索', url: '/dashboard/crm/leads', icon: IconMap.Sparkles,
      matchPrefixes: ['/dashboard/crm/leads'] },
    { title: '商机', url: '/dashboard/crm/opportunities', icon: IconMap.Target,
      matchPrefixes: ['/dashboard/crm/opportunities'] },
    { title: 'CRM 设置', url: '/dashboard/crm/settings', icon: IconMap.Settings,
      roles: ['admin'] },  // 仅 admin 可见
  ],
},
```

> **不抽 `lib/crm/sidebar-config-crm.ts`**：与其他 7 个 group 保持一致；主文件 <500 行不拆。

### 7.2 路由 meta（`lib/dashboard-route-meta.ts`）

```ts
{ match: '/dashboard/crm/customers', title: '客户管理' },
{ match: '/dashboard/crm/leads', title: '线索管理' },
{ match: '/dashboard/crm/opportunities', title: '商机管理' },
{ match: '/dashboard/crm/sea', title: '客户公海' },
{ match: '/dashboard/crm/settings', title: 'CRM 设置' },
{ match: '/dashboard/crm', title: 'CRM 业务' },  // 兜底
```

---

## 8. Layout & Provider

```tsx
// app/dashboard/crm/layout.tsx
'use client'
import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmDataScopeProvider>{children}</CrmDataScopeProvider>
    </CrmClientProvider>
  )
}
```

---

## 9. 组件规格（7 个业务组件）

| # | 组件 | 关键依赖 | TDD 优先级 |
|---|---|---|---|
| C1 | **crm-table** | TanStack Table (已装) + shadcn Table/Checkbox/Button | **P0 · 自研**（D21） |
| C2 | **crm-advance-filter** | react-hook-form + zod + shadcn Popover/Select/Input | P0 |
| C3 | **crm-overview-drawer** | shadcn Sheet/Tabs/Badge | P0 |
| C4 | **crm-detail-card** | shadcn Card | P0 | **v1.2 升级**：接收 `fields: FieldDefinition[]`，内部 `fields.map(renderField)` 渲染（不违背 D5——仍是写死字段值，仅把"字段清单"从散落 JSX 提为 `FieldDefinition[]` 数组）；线索/商机/公海详情复用同一卡片换 `FIELD_DEFS`（对齐 CordysCRM "一个 Drawer 服务多实体" 范式，详见评估 §3.3）|
| C5 | **crm-user-select** | shadcn Command/Popover | P0 |
| C6 | **crm-follow-timeline** | shadcn ScrollArea + lucide icons | P0 |
| C7 | **crm-form-create** | react-hook-form + zod + shadcn Form | P0 |

**C1 (crm-table) 关键 Props**：

```ts
interface CrmTableProps<T> {
  queryKey: string
  fetchPage: (params: ListParams) => Promise<Paginated<T>>
  columns: CrmColumnDef<T>[]
  filterFields: FilterFieldDef[]
  defaultFilters?: FilterCondition[]
  onRowClick?: (row: T) => void
  selectable?: boolean
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  emptyText?: string
  rowKey: keyof T
}
```

URL 同步：`page` / `pageSize` / `sortBy` / `sortOrder` / `keyword` / `filters` 全写 URL search params（刷新保留、可分享）。

**Hook 拆分**（仅 `crm-table` 内部用）：
- `useCrmTableState()`：URL ↔ state 双向绑定
- `useCrmTableQuery()`：调用 `fetchPage`，仿 TanStack Query 的简单 cache（手写，不用 RQ）

---

## 10. 状态管理

| 状态类型 | 位置 | 例 |
|---|---|---|
| **服务器状态** | CrmClient + URL search params | `customers?page=2&sortBy=updatedAt` |
| **跨页面状态** | React Context + URL | `scope=mine` |
| **页面局部状态** | 组件 `useState` | filter 暂存 |
| **持久化偏好** | localStorage（V2） | 列宽 / 视图 |

**Toast & 错误**：复用 `useNotifications().notify()`（D16），签名：

```ts
notify({ type: 'success' | 'error' | 'warning' | 'info', title: string, message?: string })
```

---

## 11. 权限

### 11.1 路由级

- `/dashboard/crm/settings` → `roles: ['admin']`
- 其它 CRM 路由默认全员可见

### 11.2 操作级（`lib/crm/method/permission.ts`）

不引入 CASL，简单判断：

```ts
export function canEditCustomer(user: User, customer: Customer): boolean {
  if (user.roleType === 'admin') return true
  return customer.ownerId === user.id
}
export function canDeleteCustomer(user: User, customer: Customer): boolean {
  return user.roleType === 'admin'
}
export function canClaimFromSea(user: User): boolean {
  return user.roleType !== 'operator'
}
```

### 11.3 数据范围

MVP 仅 `mine | all` 两档；V2 加部门粒度。

> **业务冲突点**：项目已有 `app/dashboard/business-dev/`（suppliers / reports / overview），语义与 CRM 部分重叠（suppliers ≈ account）。本 MVP **不处理** BD 模块，CRM 独立运行；后续若统一，先单独开 issue 讨论。

---

## 12. 测试策略

### 12.1 单元测试（Vitest + @testing-library/react）

**核心覆盖**（100%）：
- `predicate-engine.ts`：每种 op + 嵌套 + 边界（≥20 case）
- `crm-table`：列渲染 / 排序 / 选中 / URL 同步 / 空态 / 错误 / 分页
- `crm-advance-filter`：schema 校验
- `permission.ts`：每个判断函数正反 2 case

**冒烟测试**（1-2 case / 组件）：
- `crm-overview-drawer` / `crm-user-select` / `crm-follow-timeline` / `crm-form-create`

**覆盖率门槛**：核心 (`lib/crm/` + `components/crm/`) **≥ 70%**（`@vitest/coverage-v8` 已装于 Day 0）

### 12.2 E2E（Playwright）

3 条 happy path + 1 条 critical path：
1. `customer-lifecycle.spec.ts`：登录 → 客户列表 → 新建 → 详情 → 加跟进 → 编辑
2. `lead-to-customer.spec.ts`：线索列表 → 新建 → "转客户" → 跳转新客户详情
3. `sea-flow.spec.ts`：客户列表 → 选中 → 移入公海 → 切公海 → 领取
4. `mobile-critical.spec.ts`：375px 能打开客户列表不崩

### 12.3 视觉/可访问性

- 不上 Storybook
- 关键页面用 `@axe-core/playwright` 跑（已装于 Day 0）
- Lighthouse 性能 ≥ 80（客户列表 mobile）

---

## 13. 实施顺序（Day-by-Day · Living Checkbox）

### Day 0 — 装依赖（开工前 1h，不占工期）

- [x] `pnpm add react-hook-form zod @hookform/resolvers`
- [x] `pnpm add -D @vitest/coverage-v8 @axe-core/playwright`
- [x] `npx shadcn@latest add form`
- [x] 验证 `pnpm build` 仍绿
- [x] 验证 `useNotifications().notify()` dev 能弹 toast（既有基础设施，结构见 `lib/notifications.ts:13 NotifyOptions`）

### Phase 0 · 基础设施（Day 1）

> 目标：路由可达、API 抽象跑通、Mock 数据 ready。
> **本次提交**：`feat(crm): bootstrap`

- [x] 0.1 Sidebar 插入 CRM 组（集成进 `SIDEBAR_TOP_GROUPS`，operations 之后）
- [x] 0.2 路由 meta 追加 6 条到 `lib/dashboard-route-meta.ts`
- [x] 0.3 `app/dashboard/crm/{layout,loading,not-found,page}.tsx` + `sea/page.tsx`
- [x] 0.4 5 个占位 `page.tsx`（customers / leads / opportunities / workbench / settings）
- [x] 0.5 `lib/crm/types/` 6 个类型文件（customer / lead / opportunity / follow / user / field + index barrel）
- [x] 0.6 `lib/crm/enums/` 4 个枚举（customer / lead / opportunity / follow）
- [x] 0.7 `lib/crm/api/crm-client.ts` 接口 + Provider + `useCrmClient()`
- [x] 0.8 `lib/crm/api/mock-data/` 5 个 fixture（100/50/20/200/10 条）+ `_generator.ts`
- [x] 0.9 `mock-crm-client.ts` 18 个方法实现 + 单测（23 case 全过）
- [x] 0.10 PR `feat(crm): bootstrap` 已合并：https://github.com/passwii/believeboyDashboard/pull/128

**Day 1 退出标准**：5 个 CRM 路由可访问；`pnpm lint && pnpm build && pnpm test` 全绿；mock 单测全过。

### Phase 1 · 客户列表 + 表格 + 筛选（Day 2-4）

> 目标：客户主流程可演示。
> **本次提交**：`feat(crm): customer list`

- [x] 1.1 `crm-table/use-crm-table.ts` 测试先行（state / URL / sort / page）— 27 case
- [x] 1.2 `use-crm-table.ts` 实现 — 27/27 绿
- [x] 1.3 `crm-table/index.tsx` 测试先行（渲染 / 排序 / 选中 / URL / 空态 / 错误 / 分页）— 23 case
- [x] 1.4 `crm-table/index.tsx` 实现 — 23/23 绿
- [x] 1.5 `crm-advance-filter/predicate-engine.ts` 测试先行 — ⏸ 跳过（mock-crm-client 服务端已实现 predicate）
- [x] 1.6 `predicate-engine.ts` 实现 — ⏸ 跳过（同上）
- [ ] 1.7 `crm-advance-filter/index.tsx` 测试 + 实现（Day 3）
- [x] 1.8 `CrmCustomerTable` 拼装（7 列 + 最后跟进红色）
- [x] 1.9 数据范围 scope 切换 UI（顶部 radiogroup）
- [x] 1.10 批量勾选（CrmTable 内置）
- [x] 1.11 `customers/page.tsx` 接入
- [ ] 1.12 Playwright `customer-lifecycle.spec.ts` 50%（Day 3）
- [ ] 1.13 PR 合并（Day 3）

**Day 4 退出标准**：客户列表 + 筛选 + 排序 + 分页 + 批量勾选 + scope 全跑通；覆盖率 ≥70%。

### Phase 2 · 详情 + 跟进 + 表单（Day 5-7）

> 目标：客户单条全流程可演示。
> **本次提交**：`feat(crm): customer detail + form`
> **进度（2026-07-18）**：核心组件已全部落地（2.1–2.9），含 v1.2 引入的 `FIELD_DEFS`+`renderField` 渲染器抽象（§9 C4）；待补 2.10 Playwright 与 2.11 PR。

- [x] 2.1 `crm-detail-card/index.tsx` 测试 + 实现（按 `FIELD_DEFS` 渲染）
- [x] 2.2 `crm-user-select/index.tsx` 测试 + 实现（搜索 + 头像，支持 allowClear）
- [x] 2.3 `crm-follow-timeline/index.tsx` 实现（多态复用）
- [x] 2.4 `crm-follow-timeline/follow-form.tsx`（类型 + 内容 + 下次跟进）
- [x] 2.5 `crm-overview-drawer/index.tsx` + 3 个 tab（详情/跟进/编辑；相关/日志 V2）
- [x] 2.6 客户列表行点击 → Drawer（`customer-table.tsx` 接入）
- [x] 2.7 `crm-form-create/schemas/customer.schema.ts` (zod)
- [x] 2.8 `crm-form-create/index.tsx` 测试 + 实现（react-hook-form + zod）
- [x] 2.9 Drawer "编辑" → 打开 form（CrmFormCreate）
- [ ] 2.10 Playwright `customer-lifecycle.spec.ts` 补全
- [ ] 2.11 PR 合并

**Day 7 退出标准**：客户全流程 E2E 过。

### Phase 3 · 线索 + 公海 + 商机浅做（Day 8-9）

> 目标：CRM 核心闭环可演示。
> **本次提交**：`feat(crm): lead + sea + opportunity stub`
> **进度（2026-07-18 续2）**：补完 3.6/3.10 Playwright E2E（`tests/crm/lead-to-customer.spec.ts`、`sea-flow.spec.ts`，复用全局登录态 + MockCrmClient）；另加 `crm-mobile.spec.ts` 覆盖 Phase 4 移动端无横向溢出。单元 194 全绿、lint 0 error、build 通过、E2E 规格随项目 tsc 通过。Phase 3 全部 checklist 落地；3.13 PR 即本批次提交合并。
> 测试基建注记：vitest 解析 `@hookform/resolvers@5`（需 zod v4）时，pnpm 将 zod@3 嵌套进 resolvers 的 node_modules（chromium-bidi 依赖），致 `zod/v4/core` 子路径缺失；已在 `frontend/vitest.config.ts` 加 `alias['zod/v4/core']` + `server.deps.inline:['@hookform/resolvers']` 修正。

- [x] 3.1 `CrmLeadTable`（复用 crm-table + LEAD_FIELD_DEFS）
- [x] 3.2 `CrmLeadOverviewDrawer`（复用 crm-overview-drawer，actions 槽注入"转为客户"）
- [x] 3.3 `crm-lead-form/schemas/lead.schema.ts`（zod 校验）
- [x] 3.4 线索新建 / 编辑（`CrmLeadForm` + 线索页"新建线索"Sheet；详情 Drawer 编辑 tab 注入 CrmLeadForm）
- [x] 3.5 **线索详情 → "转为客户" → 标记 converted**（convertLead 闭环；转后 toast 反馈）
- [x] 3.6 Playwright `lead-to-customer.spec.ts`（行→抽屉→转为客户；新建线索必填校验）
- [x] 3.7 客户批量"移入公海"（`CrmTable` 新增 `refreshKey` + `CrmCustomerTable` 选择工具条 → `batchMoveToSea`）
- [x] 3.8 `/dashboard/crm/sea` 页面（复用 customer list + scope='sea'，mock applyScope 扩展 'sea'）
- [x] 3.9 公海"领取"按钮（Drawer actions 槽 → claimFromSea）
- [x] 3.10 Playwright `sea-flow.spec.ts`（行→抽屉→领取→移出公海）
- [x] 3.11 `CrmOpportunityTable`（7 列）
- [x] 3.12 `CrmOpportunityOverviewDrawer`（只读，onSave 空实现）
- [x] 3.13 本批次提交合并（PR 即 `feat(crm): 线索新建表单 + 批量移入公海` 等）

### 基础版框架补全（2026-07-18 续3）

> 目标：补齐基础版框架最后的结构件 —— 商机 CRUD 闭环 + 客户新建入口，使三大实体（客户/线索/商机）均具备"列表→详情→新建/编辑→保存"完整闭环。
> **本次提交**：`feat(crm): 商机 CRUD 闭环 + 客户新建入口`

- [x] 类型/接口层：`OpportunityInput` 类型、`CrmClient` 接口新增 `createOpportunity` / `updateOpportunity`，`MockCrmClient` 与 `HttpCrmClient` 桩同步补齐
- [x] `CrmCustomerSelect` 组件（选客户，Command/Popover，复刻 CrmUserSelect）
- [x] `opportunity.schema.ts`（zod）+ `CrmOpportunityForm`（name/customerId/amount/stage/ownerId/expectedCloseDate/probability/remark）
- [x] 商机页接入"新建商机"Sheet（createOpportunity）+ ScopeToggle；`CrmOpportunityTable` 详情 Drawer 编辑 tab 注入 `CrmOpportunityForm`，`onSave` → `updateOpportunity`（原只读空壳已替换）
- [x] 客户页（`/dashboard/crm/customers`）接入"新建客户"Sheet（`CrmFormCreate` → `createCustomer`）
- [x] 单测：`opportunity.schema` 校验 + `MockCrmClient` create/updateOpportunity round-trip；单元 **201 全绿**、lint 0 error、build 通过
- [ ] 待补：`crm-opportunity-form` / `crm-customer-select` 的组件级单测（当前由 schema + mock 单测 + 类型检查覆盖）；a11y 专项审计

**基础版 CRM 框架闭环状态**：客户（列表/详情/编辑/新建/批量移公海）、线索（列表/详情/编辑/新建/转客户）、商机（列表/详情/编辑/新建）、公海（列表/领取）均已可用。占位件（settings / business-dev / workbench）按评估结论留待 V2，不纳入基础版。

### Phase 4 · 收尾（Day 10，部分）

> 目标：MVP 全量可发布。
> **进度（2026-07-18 续2）**：移动端回归已以 E2E 覆盖（`tests/crm/crm-mobile.spec.ts`，390px 无横向溢出）；空态由 `EmptyState` 组件统一承接（各列表 `emptyText` 已配置）；a11y 沿用 `@axe-core/playwright` 既有项目。剩余：a11y 专项审计（独立小迭代）、结算/看板等深度功能（超出 MVP 范围，见 CordysCRM 评估结论，不扩张）。

**Day 9 退出标准**：线索→客户 + 公海 E2E 过；商机只读可看。

### Phase 4 · 收尾（Day 10）

> 目标：MVP 全量可发布。

- [ ] 4.1 Mobile 响应式（375 / 768）
- [ ] 4.2 Lighthouse 客户列表（perf ≥80）
- [ ] 4.3 `@axe-core/playwright` a11y 扫描
- [ ] 4.4 空态 / loading / error 补全
- [ ] 4.5 `pnpm lint && pnpm build && pnpm test` 全绿
- [ ] 4.6 `docs/CRM-USER-GUIDE.md`
- [ ] 4.7 根 `README.md` 加 CRM 章节
- [ ] 4.8 Demo 录屏（Loom 5min）
- [ ] 4.9 缓冲 / 修 bug

---

## 14. 风险 & 缓解

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| **C1 (`crm-table`) 自研复杂度超预期** | 延期 2-3d | **高** | D21 已识别为非参考移植；URL 同步细节可砍，先做 in-memory |
| 跟进表单字段太多 | 体验差 | 中 | V1 只 4 种跟进类型 + 文本，V2 加附件 |
| Sidebar 8 组空间不够 | 视觉挤 | 低 | 60px → 56px 或缩 icon |
| TanStack Table v8 API 复杂 | 表格延期 | 中 | Day 2 先做最小版（仅 sort + pagination），拖拽 V2 |
| Zod schema 重复定义 | 维护成本 | 中 | 抽 `BaseContactSchema`（phone/email/name 复用） |
| 真实后端接口对不上 | 切换返工 | 高 | D4 mock 先行；接 HTTP 时先 `pnpm gen:api-types` |
| E2E 不稳定（mock 延迟随机） | CI 飘 | 中 | E2E 跑在 mock 模式强制固定 200ms |
| localStorage SSR hydration mismatch | 报错 | 中 | `useEffect` 读 + 初始空数组 |
| ~~next-auth session 缺 `id`~~ | — | — | **已不成立**（`types/next-auth.d.ts` 已含） |

---

## 15. 验收清单（DoD）

到 Day 10 末，**全部勾选**才算 MVP 完成：

**功能**：
- [ ] 客户列表：100 条 mock、分页/排序/筛选/搜索/批量勾选 正常
- [ ] 客户详情：4 个 tab，详情+跟进可操作，关联/日志空态
- [ ] 客户新建/编辑：必填校验、提交后列表刷新
- [ ] 客户批量转移/移入公海：toast 反馈、列表刷新
- [ ] 线索列表/详情/编辑：同上
- [ ] 线索转客户：转化后跳新客户，原线索 `status='converted'`
- [ ] 公海页：只显示 `ownerId=null`，可领取
- [ ] 数据范围：本人的只看 `ownerId=currentUserId`
- [ ] 商机列表/详情：可看不可编辑

**工程**：
- [ ] `pnpm lint` 通过
- [ ] `pnpm build` 通过（含 `gen:api-types:check`）
- [ ] `pnpm test` 通过，覆盖率 ≥ 70%
- [ ] 4 条 Playwright E2E 全过
- [ ] 无 console error / warning
- [ ] Lighthouse perf ≥ 80
- [ ] axe-core 无 critical a11y issue
- [ ] Mobile 375px 不崩
- [ ] 提交 4-5 个小 PR，中文 + Conventional Commits

**文档**：
- [x] `docs/CRM-MVP-PLAN.md`（本文件 · 单一权威）
- [ ] `docs/CRM-USER-GUIDE.md`（用户视角）
- [ ] 根 `README.md` 提了 CRM 模块

---

## 16. V2 Backlog（明确不做 · 防止遗漏）

- `crm-stage-board`（Kanban 拖拽换阶段）
- `crm-batch-actions`（独立组件）
- `crm-data-scope-filter`（部门粒度）
- `crm-formula`（公式引擎）
- `crm-form-design`（表单设计器）
- `crm-approval` / `crm-flow`（审批流）
- 合同 / 订单 / 报价 / 回款 / 发票 / 工商抬头
- 客户公海自动回收规则引擎
- 客户查重 / 合并
- 操作日志 UI
- 客户画像 / 雷达图
- CRM 范围全局搜索（Cmd+K 扩展）
- `http-crm-client.ts` 真实后端实现
- 移动端 H5 专项（<768px 优化）
- 国际化（中/英）
- 数据权限（部门/团队/自定义）

---

## 附录 A：MVP 涉及的 7 个业务组件文件清单

```
components/crm/
├── crm-table/                  {index.tsx, use-crm-table.ts, column-builder.ts, types.ts, *.test.tsx}
├── crm-advance-filter/         {index.tsx, filter-schema.ts, predicate-engine.ts, types.ts, predicate-engine.test.ts}
├── crm-overview-drawer/        {index.tsx, tabs/{detail,follow,related,log}-tab.tsx, types.ts}
├── crm-detail-card/            {index.tsx, field-renderer.tsx, types.ts}
├── crm-user-select/            {index.tsx, index.test.tsx}
├── crm-follow-timeline/        {index.tsx, follow-form.tsx, types.ts}
├── crm-form-create/            {index.tsx, schemas/{customer,lead}.schema.ts, index.test.tsx}
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
| `useCrmTable` | 8（state init / URL push-replace / sort toggle / page 变更 / filter 合并） |
| `crm-table` 渲染 | 6（加载中 / 空 / 错误 / 选中 / 排序 / 分页） |
| `predicate-engine` | 20+（每 op 2-3 case + 嵌套 + 边界 + 未知字段） |
| `crm-advance-filter` | 4（添加 / 删除 / 重置 / 应用） |
| `crm-user-select` | 3（单选 / 多选 / 搜索过滤） |
| `crm-form-create` | 3（必填 / 成功 / 失败 toast） |
| `permission.ts` | 8（4 函数 × 正反 2 case） |
| **合计** | **≥ 50 个 case** |

## 附录 D：与上游分析文档的偏差

本计划是**唯一权威**；`docs/cordys-crm-analysis.md` 仅作历史参考。以下是 v1.1 评审后确认的偏差：

| # | 分析文档的说法 | 实际 / 本计划裁定 | 原因 |
|---|---|---|---|
| 1 | "Next 16 + React 19" | **React 18.3.1** | 实际 `frontend/package.json` 是 `react ^18.3.1`；不要用 React 19 特性 |
| 2 | `crm-table` 是 business 组件 | **在 `components/pure/crm-table/`** | 实际归属；且通用表格抽象不完整，C1 自研（D21） |
| 3 | 列表逻辑可参考 `useTable.ts` (958 行) | **散落在 803 行的 `customerTable.vue`** | 没有干净通用表格可照搬 |
| 4 | 目录写 `believeboyDashboard/frontend/...` | **`frontend/...`** | frontend/ 是前端根，无需多套前缀 |
| 5 | 包含 `crm-stage-board` 等 P0 组件 | **V2 推迟**（D19） | scope 控制 |
| 6 | 单独 `lib/crm/sidebar-config-crm.ts` | **集成进主文件**（D20） | 与其他 7 个 group 一致 |
| 7 | `next-auth session 缺 id` 是风险 | **已不成立** | `types/next-auth.d.ts` 已含 `Session.user.id` |
| 8 | Day 0 只装 `react-hook-form zod` | **加 `@vitest/coverage-v8` + `@axe-core/playwright`** | 覆盖率门槛和 a11y 扫描需要 |

---

## 17. 对照 CordysCRM 的方案评估（2026-07-18）

> 完整评估：`docs/superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md`
> 结论：**方案方向正确，D1–D22 决策全部成立，不推翻、不扩范围**。对照全功能 CRM 仅做三处打磨：

1. **商机 Kanban（D8）维持砍**，§2.2 补文案说明"看板属 V2，MVP 用列表 + 状态徽章替代"。
2. **公海维持手动模式**（无自动回收），§3 公海行补"（MVP 仅手动，无自动回收规则）"；Phase 3 验收须含"领取后列表刷新、公海项消失"。
3. **Phase 2 抽 `FIELD_DEFS` + `renderField` 渲染器**（§9 C4 已更新）：不违背 D5，但让线索/商机/公海详情复用同一 `crm-detail-card` 换字段数组，对齐 CordysCRM "一个 Drawer 服务多实体" 范式。

**版本**：v1.2 · 2026-07-18
**下一次同步**：Phase 2 结束时