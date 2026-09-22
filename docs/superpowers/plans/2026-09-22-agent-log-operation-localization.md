# Agent 日志操作中文化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent 管理页统一细化读写日志的中文操作名称，覆盖当前全部 Agent action 与 API 访问路由，同时保留原始标识用于排查。

**Architecture:** 新建前端纯函数标签模块，集中维护写 `action` 标签与访问日志的 `HTTP method + path` 匹配表。写操作面板继续通过 `operationActionLabel` 使用 action 标签；访问日志面板改用 `accessOperationLabel` 使用具体路径标签，未命中时回退到业务域中文名或原始 code。后端模型、数据库和统计接口不变。

**Tech Stack:** Next.js 16、React 18、TypeScript、Vitest、Testing Library、pnpm。

## Global Constraints

- 前端验证顺序固定为 `pnpm lint` → `pnpm build` → `pnpm test`。
- 测试先行：每个行为先写失败测试并确认失败，再写最小实现。
- 不修改后端 Agent API、审计模型、数据库迁移或统计口径。
- 未知 action/path 不隐藏、不改成笼统“其他”；继续显示可排查的原始标识或业务域。
- 访问日志路径匹配按具体路由优先于通用路由。
- Git 提交使用中文 Conventional Commits，scope 和分节抬头使用中文。

## 文件结构

- Create: `frontend/lib/agent-operation-labels.ts` — Agent 写 action 与访问路径标签的单一事实源，导出 `operationActionLabel` 与 `accessOperationLabel`。
- Create: `frontend/lib/agent-operation-labels.test.ts` — 标签纯函数的全量 action、代表性读路由、优先级与回退测试。
- Modify: `frontend/lib/agent-operation-diff.ts` — 移除重复的 action 标签表，重导出统一的 `operationActionLabel`，保持既有 import API 不变。
- Modify: `frontend/lib/agent-operation-diff.test.ts` — 保留既有写操作与 diff 回归断言，确认重导出不改变行为。
- Modify: `frontend/components/system/agent-access-logs-panel.tsx` — 用统一访问标签替换仅按业务域显示的 `operationTypeLabel`，更新标签的辅助 title。
- Modify: `frontend/components/system/agent-access-logs-panel.test.tsx` — 增加访问日志读/写动作中文化的组件回归断言。
- Modify: `frontend/components/system/agent-operation-logs-panel.test.tsx` — 增加平台巡检、客诉、凭据更新、SKU 删除和 Listing 批量写入的高频/列表回归数据。

### Task 1: 建立统一写 action 标签表

**Files:**

- Create: `frontend/lib/agent-operation-labels.ts`
- Create: `frontend/lib/agent-operation-labels.test.ts`
- Modify: `frontend/lib/agent-operation-diff.ts:90-120`
- Modify: `frontend/lib/agent-operation-diff.test.ts:1-35`

**Interfaces:**

- Produces `operationActionLabel(action: string): string`。
- Produces `accessOperationLabel(method: string, path: string, operationType: string | null): string`，供访问日志组件调用。

- [ ] **Step 1: Write the failing action-label tests**

在 `frontend/lib/agent-operation-labels.test.ts` 中先添加以下断言，覆盖现有映射和本次缺失 action：

```ts
import { describe, expect, it } from 'vitest'
import { operationActionLabel } from './agent-operation-labels'

describe('operationActionLabel', () => {
  it('映射当前 Agent 全部写 action', () => {
    const expected: Record<string, string> = {
      'shipment.create': '新建货件',
      'shipment.update': '更新货件',
      'shipment.items.replace': '替换货件明细',
      'shipment.status.transition': '货件状态变更',
      'shipment.recalculate_costs': '重算货件费用',
      'shipment.delete': '删除货件',
      'shop_calculation.append': '追加店铺测算',
      'new_product_calculation.upsert': '保存新品测算',
      'sku_info.upsert': '新建 SKU 主数据',
      'sku_info.update': '更新 SKU 主数据',
      'sku_info.status.transition': 'SKU 上下架',
      'sku_info.delete': '删除 SKU 主数据',
      'sku_info.upload_fnsku_label': '上传 FNSKU 标签',
      'sku_info.listing_copy.batch': '批量更新 Listing 文案',
      'replenishment_settings.upsert': '保存补货设置',
      'inventory_replenishment_settings.upsert': '保存补货设置',
      'platform_inspection.save': '保存平台巡检',
      'platform_inspection.submit': '提交平台巡检',
      'platform_inspection.upload_screenshot': '上传巡检截图',
      'platform_inspection.delete_screenshot': '删除巡检截图',
      'complaint_center.batch_write': '批量写入客诉',
      'agent_key.create': '自助签发凭据',
      'api_key.create': '创建凭据',
      'agent_key.update': '更新凭据权限',
      'api_key.update': '更新凭据',
    }

    for (const [action, label] of Object.entries(expected)) {
      expect(operationActionLabel(action)).toBe(label)
    }
  })

  it('未知 action 原样返回', () => {
    expect(operationActionLabel('mystery.op')).toBe('mystery.op')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails for missing mappings**

Run: `pnpm --dir frontend exec vitest run lib/agent-operation-labels.test.ts`

Expected: FAIL because `frontend/lib/agent-operation-labels.ts` does not exist yet.

- [ ] **Step 3: Implement the unified action map**

在新模块中导出 `ACTION_TITLES` 语义化映射和最小函数实现：

```ts
const ACTION_TITLES: Record<string, string> = {
  'shipment.create': '新建货件',
  'shipment.update': '更新货件',
  'shipment.items.replace': '替换货件明细',
  'shipment.status.transition': '货件状态变更',
  'shipment.recalculate_costs': '重算货件费用',
  'shipment.delete': '删除货件',
  'shop_calculation.append': '追加店铺测算',
  'new_product_calculation.upsert': '保存新品测算',
  'sku_info.upsert': '新建 SKU 主数据',
  'sku_info.update': '更新 SKU 主数据',
  'sku_info.status.transition': 'SKU 上下架',
  'sku_info.delete': '删除 SKU 主数据',
  'sku_info.upload_fnsku_label': '上传 FNSKU 标签',
  'sku_info.listing_copy.batch': '批量更新 Listing 文案',
  'replenishment_settings.upsert': '保存补货设置',
  'inventory_replenishment_settings.upsert': '保存补货设置',
  'platform_inspection.save': '保存平台巡检',
  'platform_inspection.submit': '提交平台巡检',
  'platform_inspection.upload_screenshot': '上传巡检截图',
  'platform_inspection.delete_screenshot': '删除巡检截图',
  'complaint_center.batch_write': '批量写入客诉',
  'agent_key.create': '自助签发凭据',
  'api_key.create': '创建凭据',
  'agent_key.update': '更新凭据权限',
  'api_key.update': '更新凭据',
}

export function operationActionLabel(action: string): string {
  return ACTION_TITLES[action] ?? action
}
```

从 `agent-operation-diff.ts` 删除旧的 `ACTION_TITLES` 与函数实现，并添加 `export { operationActionLabel } from './agent-operation-labels'`，保证 `describeOperation` 和现有调用点不变。

- [ ] **Step 4: Run action tests and existing diff tests**

Run: `pnpm --dir frontend exec vitest run lib/agent-operation-labels.test.ts lib/agent-operation-diff.test.ts`

Expected: PASS，新增 action 和既有 before/after diff 断言全部通过。

- [ ] **Step 5: Commit the unified action mapping**

```bash
git add frontend/lib/agent-operation-labels.ts frontend/lib/agent-operation-labels.test.ts frontend/lib/agent-operation-diff.ts frontend/lib/agent-operation-diff.test.ts
git commit -m "feat(Agent日志): 补齐写操作中文标签"
```

### Task 2: 增加访问日志的读写路径标签

**Files:**

- Modify: `frontend/lib/agent-operation-labels.ts`
- Modify: `frontend/lib/agent-operation-labels.test.ts`

**Interfaces:**

- Consumes `method`, raw `path`, and persisted `operation_type` from `AgentAccessLogItem`。
- Produces `accessOperationLabel(method, path, operationType)`，返回中文业务动作。

- [ ] **Step 1: Write failing path-label tests**

在纯函数测试中加入以下用例：

```ts
import { accessOperationLabel } from './agent-operation-labels'

describe('accessOperationLabel', () => {
  it('区分同一业务域的列表、详情和审计读取', () => {
    expect(accessOperationLabel('GET', '/api/v1/agent/projects/12/shipments', 'shipments'))
      .toBe('查询货件列表')
    expect(accessOperationLabel('GET', '/api/v1/agent/projects/12/shipments/SH-1', 'shipments'))
      .toBe('查询货件详情')
    expect(accessOperationLabel('GET', '/api/v1/agent/projects/12/shipments/SH-1/audit', 'shipments'))
      .toBe('查询货件审计')
  })

  it('覆盖测算、巡检和客诉读接口', () => {
    expect(accessOperationLabel('GET', '/api/v1/agent/projects/12/shop-calculations/skus/A-1/history', 'shop_calculations'))
      .toBe('查询 SKU 测算历史')
    expect(accessOperationLabel('GET', '/api/v1/agent/platform-inspection/template', 'platform_inspection'))
      .toBe('获取平台巡检模板')
    expect(accessOperationLabel('GET', '/api/v1/agent/complaint-center/complaints', 'complaint_center'))
      .toBe('查询客诉列表')
  })

  it('访问日志中的写路径复用 action 语义', () => {
    expect(accessOperationLabel('POST', '/api/v1/agent/projects/12/shipments/SH-1/recalculate-costs', 'shipments'))
      .toBe('重算货件费用')
    expect(accessOperationLabel('POST', '/api/v1/agent/platform-inspection/periods/3/projects/12/submit', 'platform_inspection'))
      .toBe('提交平台巡检')
  })

  it('具体路径优先于通用路径，未知值回退可排查标识', () => {
    expect(accessOperationLabel('GET', '/api/v1/agent/projects/12/shipments/SH-1/sku-summary', 'shipments'))
      .toBe('查询货件 SKU 汇总')
    expect(accessOperationLabel('GET', '/api/v1/agent/unknown-resource', 'unknown_domain'))
      .toBe('unknown_domain')
    expect(accessOperationLabel('GET', '/api/v1/agent/unknown-resource', null)).toBe('-')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir frontend exec vitest run lib/agent-operation-labels.test.ts`

Expected: FAIL because `accessOperationLabel` has not been implemented.

- [ ] **Step 3: Implement ordered access-route descriptors**

在同一标签模块新增按具体到通用顺序排列的 descriptors。路由匹配只使用去掉 query string 的 path，并统一 method 为大写；写路径直接复用 action 标签。至少包含以下实际路由：

```ts
type AccessRouteLabel = {
  method: string
  pattern: RegExp
  label: string
}

const ACCESS_ROUTE_LABELS: AccessRouteLabel[] = [
  { method: 'GET', pattern: /\/projects\/\d+\/shipments\/[^/]+\/audit$/, label: '查询货件审计' },
  { method: 'GET', pattern: /\/projects\/\d+\/shipments\/[^/]+\/sku-summary$/, label: '查询货件 SKU 汇总' },
  { method: 'GET', pattern: /\/projects\/\d+\/shipments\/[^/]+\/fba-box-detail$/, label: '查询货件装箱明细' },
  { method: 'GET', pattern: /\/projects\/\d+\/shipments\/[^/]+\/fba-delivery-template$/, label: '导出 FBA 配送模板' },
  { method: 'GET', pattern: /\/projects\/\d+\/shipments\/[^/]+$/, label: '查询货件详情' },
  { method: 'GET', pattern: /\/projects\/\d+\/shipments$/, label: '查询货件列表' },
  { method: 'POST', pattern: /\/projects\/\d+\/shipments\/[^/]+\/recalculate-costs$/, label: '重算货件费用' },
  { method: 'POST', pattern: /\/projects\/\d+\/shipments\/[^/]+\/status$/, label: '货件状态变更' },
  { method: 'PUT', pattern: /\/projects\/\d+\/shipments\/[^/]+\/items$/, label: '替换货件明细' },
  { method: 'PATCH', pattern: /\/projects\/\d+\/shipments\/[^/]+$/, label: '更新货件' },
  { method: 'POST', pattern: /\/projects\/\d+\/shipments$/, label: '新建货件' },
  { method: 'DELETE', pattern: /\/projects\/\d+\/shipments\/[^/]+$/, label: '删除货件' },
  { method: 'GET', pattern: /\/projects\/\d+\/shop-calculations\/skus\/[^/]+\/audit$/, label: '查询 SKU 测算审计' },
  { method: 'GET', pattern: /\/projects\/\d+\/shop-calculations\/skus\/[^/]+\/history$/, label: '查询 SKU 测算历史' },
  { method: 'GET', pattern: /\/projects\/\d+\/shop-calculations\/skus\/[^/]+$/, label: '查询 SKU 当前测算' },
  { method: 'GET', pattern: /\/projects\/\d+\/shop-calculations$/, label: '查询店铺测算列表' },
  { method: 'POST', pattern: /\/projects\/\d+\/shop-calculations\/compute$/, label: '试算店铺测算' },
  { method: 'POST', pattern: /\/projects\/\d+\/shop-calculations$/, label: '追加店铺测算' },
  { method: 'GET', pattern: /\/shop-calculation-history$/, label: '查询店铺测算历史' },
  { method: 'GET', pattern: /\/shop-calculation\/snapshots$/, label: '查询店铺测算快照' },
  { method: 'GET', pattern: /\/platform-inspection\/template$/, label: '获取平台巡检模板' },
  { method: 'PUT', pattern: /\/platform-inspection\/periods\/\d+\/projects\/\d+$/, label: '保存平台巡检' },
  { method: 'POST', pattern: /\/platform-inspection\/periods\/\d+\/projects\/\d+\/submit$/, label: '提交平台巡检' },
  { method: 'POST', pattern: /\/platform-inspection\/periods\/\d+\/projects\/\d+\/screenshots$/, label: '上传巡检截图' },
  { method: 'DELETE', pattern: /\/platform-inspection\/screenshots\/\d+$/, label: '删除巡检截图' },
  { method: 'GET', pattern: /\/complaint-center\/complaints$/, label: '查询客诉列表' },
  { method: 'POST', pattern: /\/complaint-center\/batch$/, label: '批量写入客诉' },
]

export function accessOperationLabel(method: string, path: string, operationType: string | null): string {
  const normalizedMethod = method.trim().toUpperCase()
  const pathname = path.split('?')[0]
  const match = ACCESS_ROUTE_LABELS.find(
    (item) => item.method === normalizedMethod && item.pattern.test(pathname)
  )
  if (match) return match.label
  if (operationType) return getAgentDomain(operationType)?.label ?? operationType
  return '-'
}
```

ordered descriptor 必须覆盖以下当前路由；同一业务域的 raw/alias 端点使用“查询……原始数据”，aggregate 端点使用“查询……汇总”，特殊端点使用表中指定文案：

- 新品测算：`GET /projects/{project_id}/new-product-calculations`（查询新品测算列表）、`GET .../skus/{sku}`（查询 SKU 新品测算）、`GET .../skus/{sku}/audit`（查询 SKU 新品测算审计）、`POST .../new-product-calculations`（保存新品测算）、`POST .../new-product-calculations/compute`（试算新品测算）。
- SKU 主数据：`GET /projects/{project_id}/sku-info`（查询 SKU 主数据列表）、`GET .../sku-info/{id}`（查询 SKU 主数据详情）、`GET .../sku-info/{id}/audit`（查询 SKU 主数据审计）；写路径对应 `新建 SKU 主数据`、`更新 SKU 主数据`、`SKU 上下架`、`删除 SKU 主数据`、`批量更新 Listing 文案`、`上传 FNSKU 标签`。
- 退货分析：`GET /projects/{project_id}/return-analysis/overview`（查询退货分析概览）、`GET .../return-analysis`（查询退货分析汇总）、`GET .../return-analysis-raw`（查询退货分析原始数据）、`GET .../return-analysis/skus/{sku}`（查询 SKU 退货分析）、`GET .../return-analysis/coverage`（查询退货分析覆盖度）。
- 补货分析：`GET /projects/{project_id}/replenishment-analysis`（查询补货分析清单）、`GET .../replenishment-analysis/skus/{sku}`（查询 SKU 补货分析）、`GET .../replenishment-analysis/summary`（查询补货分析总览）、`GET .../replenishment-analysis/coverage`（查询补货覆盖度）、`GET .../replenishment-analysis/settings`（读取补货设置）；写路径显示 `保存补货设置`。
- 库存与台账：`GET /projects/{project_id}/inventory`（查询库存信息）；库存台账的 `/months`、`/snapshot`、`/events`、`/receipt-clusters`、`/integrity`、`/trend`、`/detail`、`/summary`、`/batches`、`/consistency` 分别显示查询可用月份、查询库存台账快照、查询库存台账事件、查询入库簇、检查库存台账完整性、查询库存台账趋势、查询库存台账明细、查询库存台账汇总、查询库存台账批次、检查库存台账一致性。
- 巡检与报表：`GET /account-health/periods`（查询巡检周期列表）、`GET /account-health/periods/current`（查询当前巡检周期）、`GET /account-health/periods/{period_id}/overview`（查询巡检周期概览）、`GET /account-health/periods/{period_id}/projects/{project_id}`（查询项目巡检报告）、`GET /account-health/history`（查询巡检历史）；`GET /platform-inspection/template`（获取平台巡检模板）；`GET /report-upload-status`（查询报表上传状态）；`POST /upload/validate`（校验报表上传）、`POST /upload/commit`（提交报表上传）。
- 销售与项目：`GET /projects/{project_id}/sales/summary`（查询销售数据汇总）、`GET /projects`（查询项目列表）。
- 广告分析：对 `/ad-campaigns`、`/ad-budgets`、`/ad-targets`、`/ad-placements`、`/ad-promoted-products`、`/ad-purchased-products`、`/ad-search-terms`、`/ad-search-term-shares`、`/ad-invalid-traffic`、`/ad-time-trends` 的 aggregate 路径显示“查询广告{对象}汇总”，对应 `-raw` 与单数 alias 路径显示“查询广告{对象}原始数据”。
- 凭据与客诉：`GET /provisioning/keys`（查询凭据列表）、`GET /complaint-center/complaints`（查询客诉列表）；写路径分别显示 `自助签发凭据`、`更新凭据权限`、`批量写入客诉`。

`getAgentDomain` 从 `frontend/lib/agent-domains.ts` 复用，避免重复业务域中文名；未列出的未知 path 仍按 `operationType` 或原始 code 回退。

- [ ] **Step 4: Run path-label tests and refine route order until green**

Run: `pnpm --dir frontend exec vitest run lib/agent-operation-labels.test.ts`

Expected: PASS，具体路径不会被通用详情/列表规则抢先匹配，query string 不影响命中，未知业务域按约定回退。

- [ ] **Step 5: Commit the access-route mapping**

```bash
git add frontend/lib/agent-operation-labels.ts frontend/lib/agent-operation-labels.test.ts
git commit -m "feat(Agent日志): 细化访问路径中文动作"
```

### Task 3: 接入访问日志面板并补组件回归

**Files:**

- Modify: `frontend/components/system/agent-access-logs-panel.tsx:25-115,430-470,645-670`
- Modify: `frontend/components/system/agent-access-logs-panel.test.tsx:1-220`
- Modify: `frontend/components/system/agent-operation-logs-panel.test.tsx:90-145`

**Interfaces:**

- Consumes `accessOperationLabel(row.method, row.path, row.operation_type)`。
- Keeps existing `operation_type` filter values and API requests unchanged。

- [ ] **Step 1: Add failing component assertions**

在访问日志 fixture 中加入同一 `shipments` 域的详情和审计行，并加入平台巡检 POST 行；断言表格显示 `查询货件详情`、`查询货件审计`、`提交平台巡检`，且路径仍然存在。写操作 fixture 的 summary/list 增加以下新增 actions 并断言对应中文名称：

```ts
const newActions = [
  ['platform_inspection.upload_screenshot', '上传巡检截图'],
  ['platform_inspection.save', '保存平台巡检'],
  ['platform_inspection.submit', '提交平台巡检'],
  ['complaint_center.batch_write', '批量写入客诉'],
  ['sku_info.delete', '删除 SKU 主数据'],
  ['sku_info.listing_copy.batch', '批量更新 Listing 文案'],
  ['agent_key.update', '更新凭据权限'],
] as const
```

Run: `pnpm --dir frontend exec vitest run components/system/agent-access-logs-panel.test.tsx components/system/agent-operation-logs-panel.test.tsx`

Expected: FAIL because the panel still renders only `operationTypeLabel` and the new action fixture labels are not yet present.

- [ ] **Step 2: Wire the unified access label into the panel**

在访问日志面板中：

1. 删除 `AGENT_DOMAINS` / `getAgentDomain` 的直接格式化依赖，改为导入 `accessOperationLabel`。
2. 将操作列改为：

```tsx
<TermCell>
  {row.operation_type || row.path ? (
    <span
      title={`${row.method} ${row.path}${row.operation_type ? ` · 业务域 ${row.operation_type}` : ''}`}
      className="border border-term-accent/40 px-1 font-mono text-[10px] text-term-accent"
    >
      {accessOperationLabel(row.method, row.path, row.operation_type)}
    </span>
  ) : (
    <span className="text-term-faint">—</span>
  )}
</TermCell>
```

3. 详情 Dialog 的“操作类型”字段使用相同函数，确保列表和详情一致。
4. 将列标题从“操作类型”改为“操作”，并保留 `operation_type` 筛选控件的名称不变，避免误解筛选参数。

- [ ] **Step 3: Run component tests and verify green**

Run: `pnpm --dir frontend exec vitest run components/system/agent-access-logs-panel.test.tsx components/system/agent-operation-logs-panel.test.tsx`

Expected: PASS，访问日志读写动作均显示细化中文；原始 path、筛选请求参数、分页和详情行为保持通过。

- [ ] **Step 4: Commit panel integration**

```bash
git add frontend/components/system/agent-access-logs-panel.tsx frontend/components/system/agent-access-logs-panel.test.tsx frontend/components/system/agent-operation-logs-panel.test.tsx
git commit -m "feat(Agent管理): 接入读写操作中文标签"
```

### Task 4: 全量验证与交付检查

**Files:**

- Modify only if verification exposes a concrete failure in files from Tasks 1–3。

- [ ] **Step 1: Run targeted regression suite**

Run: `pnpm --dir frontend exec vitest run lib/agent-operation-labels.test.ts lib/agent-operation-diff.test.ts components/system/agent-access-logs-panel.test.tsx components/system/agent-operation-logs-panel.test.tsx`

Expected: PASS，所有相关测试通过。

- [ ] **Step 2: Run repository-required lint**

Run: `pnpm --dir frontend lint`

Expected: exit code 0，无 ESLint error。

- [ ] **Step 3: Run repository-required build**

Run: `pnpm --dir frontend build`

Expected: exit code 0，API 类型检查和 Next.js production build 完成。

- [ ] **Step 4: Run repository-required full test suite**

Run: `pnpm --dir frontend test`

Expected: exit code 0，Vitest 全部通过。

- [ ] **Step 5: Inspect diff and final status**

Run: `git diff --check && git status --short && git log --oneline -5`

Expected: 无空白错误；只包含本任务提交与既有未跟踪 `.codex/`，不添加或修改 `.codex/`。

- [ ] **Step 6: Report delivery**

交付说明必须包含：统一标签模块路径、读写映射覆盖范围、实际执行的验证命令与结果、未改动后端契约，以及用户需要重点验收的页面路径 `/dashboard/system/agent-management`。
