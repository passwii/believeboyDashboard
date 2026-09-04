# Agent 接入管理页重构设计（BLF-448 · 方案 A Hub 枢纽页）

> **状态**：已确认（用户 2026-08-06 拍板「按照你的推荐来实施」）
> **范围**：`dashboard/system/agent-management` 页面 + `agent_api_keys` 域授权
> **关联**：`docs/agent-api-design.md`（Agent API 设计稿）、`docs/external-api-ops-agent-roadmap.md`（业务域全景图）

## 1. 背景与目标

第一期交付了「Agent 凭据管理」单扁平页：凭据列表 + 创建 Dialog + 写死货件域示例的调用指南。但业务已出现第二个域（店铺测算 BLF-442），`/external/*` 还有 20+ 待迁移域。目标：

1. **业务域为轴**：页面从「凭据中心」变为「业务域中心」，一眼看清哪些域已接入、哪些在规划。
2. **按域授权**：一张凭据可勾选能访问的业务域（`business_scope`），域级 403 强制。
3. **域注册表驱动**：新增业务域 = 注册表 +1 条 + 后端挂路由，页面零改动。
4. **调用指南按域**：不再写死货件示例。
5. **访问日志并入**：本页可看 Agent 访问日志，无需跳日志查看页。

## 2. 信息架构（页面重组为 4 Tab）

```
Agent 接入管理
├── Tab 1 业务域概览    域卡片网格：货件 ✅ / 店铺测算 ✅ / 退货分析 🚧 / 广告 🚧…
│                      每卡：中文名、接入状态、路由数、读写能力、授权凭据数
├── Tab 2 凭据管理      现有凭据表 + 新增「业务域范围」列 + 按域筛选
│                      创建 Dialog 新增「业务域范围」多选（全部 / 指定域）
├── Tab 3 调用指南      域切换器 → 按域渲染调用说明（货件 / 店铺测算 / 占位）
└── Tab 4 访问日志      复用 agent-access-logs 端点，独立面板组件
```

## 3. 域注册表（前端配置，`frontend/lib/agent-domains.ts`）

```ts
type AgentDomain = {
  code: string            // 后端 business_scope 取值，如 'shipments'
  label: string           // 中文名
  status: 'live' | 'planned'
  routeCount: number      // agent 命名空间路由数（展示用）
  capabilities: { read: boolean; write: boolean }
}
```

首版注册表条目：

| code | label | status | 说明 |
|---|---|---|---|
| shipments | 货件管理 | live | 11 路由（读写） |
| shop_calculations | 店铺测算 | live | 6 路由（读写） |
| return_analysis | 退货分析 | planned | roadmap L1 待迁移 |
| ad_analysis | 广告分析 | planned | 10 广告域聚合 |
| inventory_ledger | 库存台账 | planned | roadmap 已覆盖 |
| finance_profit | 财务利润 | planned | roadmap L2 待定口径 |

> 规划域只做展示（概览 Tab 灰显），不参与授权枚举；后续接入时把 status 翻成 live + 后端挂路由即可。

## 4. 后端授权模型

### 4.1 数据模型

`agent_api_keys` 新增列（迁移 236）：

```
business_scope  String(255)  NOT NULL  server_default='*'
```

语义与 `project_scope` 完全对齐：

- `*` = 全业务域放行（存量 key 兼容，行为不变）
- 否则 `,` 分隔的域 code 白名单（如 `shipments,shop_calculations`）
- 空串由 service 层归一为 `*`

### 4.2 依赖函数（`app/api/agent/scope.py`）

```python
def require_business_scope(domain: str):
    """返回依赖：校验 key 的 business_scope 是否含 domain。"""
    ...
```

仿照 `require_project_scope`：读 `request.state.agent_api_key_id` → 查 key → `*` 放行 / 白名单命中放行 / 未命中 403 `AGENT_BUSINESS_OUT_OF_SCOPE` / key 行丢失 401 fail closed。

### 4.3 路由接线

两个域路由各自挂域依赖（在 `agent/__init__.py` 的 namespace 鉴权之后自然执行）：

- `shipments_router` → `Depends(require_business_scope("shipments"))`
- `shop_calculations_router` → `Depends(require_business_scope("shop_calculations"))`

> ⚠️ 路由遮蔽警告（`agent/__init__.py` 注释）：新增 include_router 必须插在兜底路由之前。

### 4.4 错误码

`errors.py` 新增 `AGENT_BUSINESS_OUT_OF_SCOPE = "AGENT_BUSINESS_OUT_OF_SCOPE"`，HTTP 403，默认文案「本凭据未被授权访问该业务域」。

### 4.5 管理端点

- `ApiKeyCreateRequest` / `ApiKeyCreateResponse` / `ApiKeyItem` 增加 `business_scope` 字段
- `key_service.create_api_key` 增加 `business_scope="*"` 参数
- `POST /api/v1/internal/api-keys` 透传

## 5. 调用指南按域

`buildUsageText` 增加 `domain` 参数（默认 `shipments` 保持兼容）：

- `shipments`：现有货件示例（原样保留）
- `shop_calculations`：店铺测算 6 路由示例（列表/SKU 详情/history/audit/append/compute）
- 未知域 → 通用骨架 + 占位说明

Tab 3 用域切换器选域渲染对应指南；复制调用说明按钮按当前域生成。

## 6. 访问日志面板复用

从 `logs/page.tsx` 抽离 Agent 访问日志 Tab 为独立组件 `components/system/agent-access-logs-panel.tsx`（自持状态与拉取），日志页与本页 Tab 4 共用。日志页行为不变（同一端点、同一筛选）。

## 7. 命名与导航

- 侧栏「Agent 凭据」→「Agent 接入管理」，路由 meta 同步
- URL 保持 `/dashboard/system/agent-management`（不破坏书签与 crawl 测试）

## 8. 测试

- 后端：`tests/api/agent/test_business_scope.py`（迷你 app 契约：`*` 放行 / 白名单命中 / 未命中 403 / key 丢失 401 / 空串归一）；internal api-keys 测试补 business_scope 断言
- 前端：注册表纯函数单测（normalize/format/scope 判断）、指南按域单测、页面测试（Tab 渲染、创建带域）、crawl 测试更新标题断言
- 验证顺序：`cd backend && pytest` → `pnpm lint` → `pnpm build` → `pnpm test`

## 9. 不在本期范围（YAGNI）

- `scope`（read/write）字段校验——`business_scope` 是域维度授权，读写分离后续单独设计
- 域级访问日志聚合（按域过滤日志）——保留 90 天口径不变，筛选已是 keyword/method/result
- 子路由拆分（方案 B）——Tab 足够，域详情子页等域多了再演进
