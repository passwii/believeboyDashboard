# Agent API 文件型资源二进制响应规范

> 状态：✅ 完成 · 分支：`codex/fba-template-agent-api` · 日期：2026-09-28

## 文档入口

| 文档 | 内容 |
|---|---|
| [设计规格](../../specs/2026-09-28-agent-file-binary-contract-design.md) | Agent 文件响应规则、审计边界和设计决定 |
| [实施计划](2026-09-28-agent-file-binary-contract.md) | helper、FBA 迁移、OpenAPI 与验证步骤 |

## 阶段进度

| 阶段 | 状态 | 结果 |
|---|---|---|
| 文件路由审计 | ✅ | FBA 模板是唯一直接交付文件的 Agent 成功响应 |
| 二进制响应 helper | ✅ | 统一媒体类型、Content-Length、RFC 5987 文件名与惰性分块 |
| FBA 路由与 OpenAPI | ✅ | 复用 helper，OpenAPI 明确 `format: binary` |
| 文档与契约测试 | ✅ | 更新 Agent API 规范和本地 Agent skill 索引 |

## Git 标签与关联

- Git 标签：无。
- API 契约：[docs/agent-api-design.md](../../../agent-api-design.md#文件型资源响应规范)
- 实现：`backend/app/api/agent/file_response.py` 与 Agent shipments FBA 模板路由。

## 验证快照

- helper + FBA 路由专项：13 passed。
- Agent 货件/OpenAPI 扩展回归：73 passed；Alembic 静态检查通过。
- 前端 lint、build 和 OpenAPI 类型同步检查通过。
- 后端失败用例在完整测试环境下重跑后仍有 25 项：8 项平台巡检 country 契约/项目校验，13 项页面渲染或头像上传缺云存储配置，1 项 CRM 和 2 项库存测试假对象形状不符，1 项 `pydantic_ai` 版本断言不符。均不触及本次改动文件。
- 全量前端 Vitest 单 worker 长时间占用高 CPU 且无测试进度，已中断；未涉及前端业务逻辑文件。
