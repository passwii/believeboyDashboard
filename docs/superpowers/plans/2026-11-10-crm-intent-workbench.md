# 意向客户工作台（CRM · crm_intent）实施计划

> **For agentic workers:** 配合设计稿与 Agent API spec 执行；按任务边界改文件，完成后回报 Lead。步骤用 checkbox 跟踪。
> 设计稿：docs/superpowers/specs/2026-11-10-crm-intent-workbench-design.md
> Agent spec：docs/superpowers/specs/2026-11-10-agent-crm-intent-api.md

**Goal:** 在 CRM 下新增「意向客户」页面：AI/人工批次导入 + PostgreSQL 存储 + 人工跟进（整条记录对 AI 锁死）+ V4 页面 + 转为客户。

**Architecture:** Go Gateway 新增独立模块 crm_intent（用户接口 /api/v1/crm/intent/*、Agent 接口 /api/v1/agent/crm-intent/*），新表 crm_intent_*（Alembic 285），R2 归档批次原始文件；Next.js 新增 /dashboard/crm/intent（V4 Warm Ledger）；刷新 + 15s 轮询。

**Tech Stack:** Go 1.27 + chi + pgx + aws-sdk-s3（blob）；Python Alembic + SQLAlchemy（仅模型）；Next.js App Router + React + TypeScript + CSS Modules + Vitest/Testing Library。

## Global Constraints

- **工作区：** /Users/damon/DamonProjects/believeboyDashboard/.worktrees/crm-intent（分支 feat/crm-intent-workbench）。**禁止改动主工作区**；主工作区正在部署。
- **禁止 git 提交/切分支/checkout**：所有改动留工作区，由 Lead 统一提交。
- **人工锁（硬约束）：** 人工任何写 → human_touched_at/by；AI 写必须 WHERE human_touched_at IS NULL；AI 不允许写 owner/跟进/锁定/转换/删除。
- **视觉：** V4 Warm Ledger，只用 --warm-ledger-* 与 Warm 控件；禁止玻璃拟态/极光/主题切换/Canvas 特效/自创颜色；桌面 1440x900，四态分离。
- **API 契约：** 以两份 spec 为准；字段 snake_case；分页 {items,total,page,page_size}；错误 {detail:{code,message}}。
- **轮询：** 不做 SSE；/meta 15s + 手动刷新。
- **测试：** 每个任务带测试；最终 T3（后端全量 pytest + go test，前端全量 pnpm test + lint + build）。

## File Map

### Backend（BE agent 独占）
- backend/alembic/versions/20261110_285_crm_intent_tables.py
- backend/app/models/crm_intent.py + backend/app/models/__init__.py（注册模型）
- backend/app/models/crm.py（CrmCustomerSource 增加 customer_radar）
- backend-go/internal/api/crm_intent/{types.go,registrar.go,handler_companies.go,handler_followup.go,handler_batches.go,agent.go,helpers.go}
- backend-go/internal/store/crm_intent.go
- backend-go/cmd/gateway/dependencies.go（needsDatabase/objectStore/CustomRegistrars）
- backend-go/internal/config/config.go（ModuleCRMIntent 常量）
- backend-go/internal/api/agent_credentials/validation.go（knownBusinessDomains）
- backend-go/tests/contract/stage10_crm_intent_contract_test.go
- deploy/deploy-remote.sh、deploy/deploy-local.sh、deploy/go.env.example、docs/deployment/dashboard-vps-compose.md（GO_API_OWNED 追加 crm_intent）

### Frontend（FE agent 独占）
- frontend/app/dashboard/crm/intent/{page.tsx,page.test.tsx,intent-warm.module.css,_components/*}
- frontend/lib/crm/intent/{types.ts,client.ts,http-client.ts,dto-mappers.ts,use-intent-polling.ts,use-intent-filters.ts} + tests
- frontend/lib/dashboard-route-meta.ts（title + warm 元数据）
- frontend/lib/sidebar-config.ts（CRM 组新增项）
- 路由矩阵测试：frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx、frontend/tests/dashboard/warm-ledger-expansion-desktop.spec.ts、frontend/tests/crawl/discovery.spec.ts
- frontend/components/crm/crm-source 枚举映射（customer_radar 中文）

## Tasks

### T1 后端基础（BE）
- [ ] 读 spec；确认 alembic head（应为 284）。
- [ ] 写迁移 285：8 张表 + 索引 + crm_intent_meta 初始化行；revision id '285'，run backend/scripts/check_alembic.py。
- [ ] 写 SQLAlchemy 模型（crm_intent.py + __init__ 注册 + CrmCustomerSource）。若迁移与模型存在不一致，以迁移为准。
- [ ] Go 领域类型 + Store 接口 + 错误码（types.go）；枚举 code/label。
- [ ] store/crm_intent.go：pgx 查询/事务；人工写统一方法设置 human_touched；AI 更新带 WHERE human_touched_at IS NULL；rev 递增（data_rev/followup_rev）；upsert 键 credit_code/name_key；手机号归一化。
- [ ] registrar.go + helpers：ModuleName=crm_intent；用户路由 With(requireAPIKey)；agent 路由在 agent.go 提供 registerAgentRoutes，registrar 调用；先保证可编译。
- [ ] 依赖装配：dependencies.go（needsDatabase/objectStore/CustomRegistrars）、config.go 常量、agent scope 白名单、deploy 脚本 GO_API_OWNED。
- [ ] 测试：store 纯函数（归一化/upsert 键/状态 label）+ handler 单测（fake store）；<code>cd backend-go && go test ./...</code> 通过。

### T2 用户端接口（BE）
- [ ] GET /meta（stats/facets/batch/revs）、GET /companies、GET /companies/{id}（含 shared_phones）、GET /board、GET /pool、GET /facets。
- [ ] PATCH /companies/{id}/followup（If-Match/version/409）、POST claim、PATCH profile、POST/PATCH/DELETE phones、POST convert（写 crm_customers/crm_contacts/source=customer_radar + 审计）。
- [ ] GET /export CSV（24 列 + owner/状态/下次联系/转客户）+ operation audit。
- [ ] POST /batches/upload（admin，multipart JSON/CSV/XLSX）+ GET /batches；共用 ingest；R2 归档（blob.ObjectStore，ObjectKey）；R2 未配置 503。
- [ ] 审计：crm_audit_logs（跟进/资料/转换）+ operation_audit_logs（导入/导出/锁定拒绝）。
- [ ] handler 测试覆盖：scope 权限、409、锁定跳过、导出、导入解析。

### T3 Agent API（BE）
- [ ] agent.go：/api/v1/agent/crm-intent/* 全部端点；agentauth.RequireAgentCredential + RequireBusinessScope("crm_intent") + rate limiter。
- [ ] Idempotency-Key：crm_intent_import_requests 预约/完成/冲突；7 天清理策略（可只写注释/任务）。
- [ ] 字段白名单（严格 JSON，禁止字段 422）；AI 读接口不返回 note/跟进时间，只返回 state/owner/human_touched/converted。
- [ ] 锁定拒绝：批量 skipped_locked、单条 409 INTENT_RECORD_LOCKED、池筛入 409。
- [ ] 契约测试 stage10：双鉴权、幂等重放/冲突、锁定、403/401/429、R2 503。

### T4 前端只读（FE）
- [ ] 读 spec；安装/复用依赖无需新增（若必须新增依赖先问 Lead）。
- [ ] lib/crm/intent：types/client/http-client/dto-mappers/use-intent-polling/use-intent-filters；BASE=/api/backend/v1/crm/intent。
- [ ] page.tsx + intent-warm.module.css：WarmCrmPage 布局、Toolbar（scope/批次/同步状态/刷新/导入(admin)/导出/视图切换）、stat panels、筛选区、三 tab、卡片/表格、pool 表、board。
- [ ] 三处路由注册 + 路由矩阵测试更新。
- [ ] 状态：loading/empty/error/zero-data；轮询 15s（hidden 暂停）；筛选/tab/scope/page 进 URL。
- [ ] 测试：client/DTO、page.test、关键组件；<code>cd frontend && pnpm exec vitest run app/dashboard/crm/intent lib/crm/intent</code>。

### T5 前端写路径（FE）
- [ ] 详情抽屉（WarmCrmRecordDrawer）：关键信息/手机号（补录/有效/共用）/意向判断/产品/平台适配/来源/疑点/跟进（状态/备注 debounce/flush/下次联系/复制摘要/转为客户）。
- [ ] 写 hooks：乐观更新 + version 409 冲突提示/刷新；备注自动保存。
- [ ] 共用号码 Dialog；导入批次 Dialog（admin）；导出 CSV（download-csv 范式）。
- [ ] 测试：抽屉/写路径/导入/冲突；<code>pnpm check:mocks</code> 不新增不稳定 mock。

### T6 集成与验收（Lead）
- [ ] 合并两路代码；<code>cd backend && pytest</code>（T3），<code>cd backend-go && go test ./...</code>，<code>cd frontend && pnpm test && pnpm lint && pnpm build</code>。
- [ ] 修复集成问题；跑桌面 1440x900 E2E（路由矩阵 + 关键链路）。
- [ ] 独立 Reviewer（Luna/max，只读）复核 diff；修完再复跑。
- [ ] Lead 统一提交（中文 Conventional Commits），更新 docs 状态；部署前确认 GO_API_OWNED。

## 验证命令（worktree）

~~~bash
WT=/Users/damon/DamonProjects/believeboyDashboard/.worktrees/crm-intent
cd "$WT/backend" && python scripts/check_alembic.py && pytest -q
cd "$WT/backend-go" && go test ./...
cd "$WT/frontend" && pnpm exec vitest run <target> && pnpm lint && pnpm build
~~~

## 协作约定

- 只改自己 File Map 内的文件；跨范围改动先 send_message 给 lead。
- 不 commit、不切分支、不跑 git deploy；不动主工作区。
- 完成后 send_message 给 lead：完成项、测试命令与结果、未完成/风险、涉及文件列表。
