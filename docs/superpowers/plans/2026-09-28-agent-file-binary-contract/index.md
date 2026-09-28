# Agent API 文件型资源二进制响应规范

> 状态：✅ 完成 · 分支：`codex/fba-template-agent-api-pr` · 日期：2026-09-28

## 文档入口

| 文档 | 内容 |
|---|---|
| [设计规格](../../specs/2026-09-28-agent-file-binary-contract-design.md) | Agent 文件响应规则、审计边界和设计决定 |
| [实施计划](2026-09-28-agent-file-binary-contract.md) | helper、FBA 迁移、OpenAPI 与验证步骤 |

## 阶段进度

| 阶段 | 状态 | 结果 |
|---|---|---|
| 文件路由审计 | ✅ | FBA 模板原先使用 JSON/Base64；店铺测算 XLSX 导出原先已返回二进制 |
| 二进制响应 helper | ✅ | 两个 XLSX 下载端点统一媒体类型、Content-Length、RFC 5987 文件名与惰性分块 |
| Agent XLSX 路由与 OpenAPI | ✅ | FBA 与店铺测算导出复用 helper，OpenAPI 均明确 `format: binary` |
| 文档与契约测试 | ✅ | 更新 Agent API 规范、本地 Agent skill 索引和两条文件路由测试 |

## Git 标签与关联

- Git 标签：无。
- API 契约：[docs/agent-api-design.md](../../../agent-api-design.md#文件型资源响应规范)
- 实现：`backend/app/api/agent/file_response.py`、Agent shipments FBA 模板路由与 shop-calculations XLSX 导出路由。

## 验证快照

- helper + FBA 路由专项：13 passed。
- 店铺测算导出专项（含 OpenAPI 二进制声明）：4 passed。
- Agent 货件/OpenAPI 扩展回归：73 passed；Alembic 静态检查通过。
- 前端 lint、build 和 OpenAPI 类型同步检查通过。
- 后端最终全量套件：3754 passed、25 failed、14 skipped；25 项失败仍与此前 `origin/main` 基线记录的失败类别一致（平台巡检契约、页面渲染/头像云存储配置、CRM/库存假对象形状、`pydantic_ai` 版本断言）。
- Insight 测试曾因有限随机日期窗口与持久 `BLF_test` 中已提交的幂等键碰撞而返回 409。测试改为查询占用键、选择空闲窗口并清理自身 queued run；此前可复现的相邻测试顺序 51 passed，最终完整套件未再出现该失败。
- 全量前端 Vitest 单 worker 长时间占用高 CPU 且无测试进度，已中断；未涉及前端业务逻辑文件。
