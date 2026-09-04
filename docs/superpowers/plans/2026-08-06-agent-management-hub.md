# Agent 接入管理页重构实施计划（BLF-448）

> **状态**：进行中
> **关联设计**：[`docs/superpowers/specs/2026-08-06-agent-management-hub-design.md`](../specs/2026-08-06-agent-management-hub-design.md)
> **实施人**：前端工程师 Seth

## 阶段 0：文档（已完成）

- [x] 设计文档 `docs/superpowers/specs/2026-08-06-agent-management-hub-design.md`
- [x] 本计划

## 阶段 1：后端域授权（已完成）

- [x] 迁移 `236`：`agent_api_keys.business_scope`（String(255) NOT NULL server_default='*'）
- [x] `models/agent_api_key.py` 加列
- [x] `schemas/agent_api_key.py`：CreateRequest / CreateResponse / ApiKeyItem 加 `business_scope`
- [x] `services/agent/key_service.py`：create_api_key 加 `business_scope="*"` 参数
- [x] `api/agent/errors.py`：`AGENT_BUSINESS_OUT_OF_SCOPE` 403
- [x] `api/agent/scope.py`：`require_business_scope(domain)` 工厂
- [x] `agent/__init__.py`：两个域路由挂依赖（兜底路由之前）
- [x] `endpoints/internal/api_keys.py` 透传

## 阶段 2：后端测试（已完成）

- [x] `tests/api/agent/test_business_scope.py`（迷你 app 契约）
- [x] `tests/api/test_internal_api_keys_agent.py` 补 business_scope 断言
- [x] `tests/api/conftest.py` `make_api_key` 加 business_scope 透传
- [x] `cd backend && pytest tests/api/agent tests/api/test_internal_api_keys_agent.py`（146 passed + 1 skipped）

## 阶段 3：前端注册表 + API client（已完成）

- [x] `lib/agent-domains.ts`：类型 + 6 域注册表 + normalize/format/scopeHasDomain 纯函数
- [x] `lib/api/agent-key-admin.ts`：类型加 `business_scope` + create 透传

## 阶段 4：前端页面重组（已完成）

- [x] 抽 `components/system/agent-access-logs-panel.tsx`（从 logs/page.tsx 抽离，两页共用）
- [x] `logs/page.tsx` 换成共用面板（行为不变）
- [x] `agent-management-client.tsx` 重组 4 Tab
- [x] `agent-usage-guide.tsx`：`buildUsageText` 加 `domain` 参数 + 店铺测算示例
- [x] 侧栏/路由 meta 改名「Agent 接入管理」

## 阶段 5：前端测试（已完成）

- [x] `lib/agent-domains.test.ts`：normalize/format/scopeHasDomain（15 断言）
- [x] `agent-usage-guide.test.ts`：补 domain 分支
- [x] `agent-management-client.test.tsx`：Tab 渲染 / 创建带域 / 筛选（6 用例）
- [x] `tests/crawl/agent-management.spec.ts` 标题断言更新

## 阶段 6：验证 + 提交（进行中）

- [x] `pnpm lint`（0 errors）→ `pnpm build`（通过）→ `pnpm test`（472 passed）
- [x] 后端全量 pytest：23 failed 与 origin/main 基线**逐字节一致**（无回归）
- [ ] commit（中文 Conventional Commits）+ push + 部署（后端改动触发 VPS）

## 风险与对策

- **logs/page.tsx 抽组件回归**：抽离后日志页跑 crawl discovery 确认 URL 正常；面板行为不变（同端点同筛选）
- **crawl 测试标题**：改名后同步更新断言（`Agent 凭据管理` → `Agent 接入管理`）
- **路由遮蔽**：`agent/__init__.py` 兜底路由必须保持最后
- **迁移撞车**：建迁移前先 `git fetch && rebase origin/main` 确认单 head（当前 235）
