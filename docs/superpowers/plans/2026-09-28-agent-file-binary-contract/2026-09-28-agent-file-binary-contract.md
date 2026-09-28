# Agent API 文件型资源二进制响应规范实施计划

> 设计规格：[2026-09-28-agent-file-binary-contract-design.md](../../specs/2026-09-28-agent-file-binary-contract-design.md)
> 状态：✅ 完成（文件响应回归通过；全量验证已复核，见目录 `index.md`）

## 目标

建立 Agent API 文件交付的统一二进制响应约定；让 FBA 模板和既有店铺测算 XLSX 导出使用共享 helper；用契约测试锁定成功与失败响应形状。

## 实施步骤

1. **先写测试（RED）**
   - 新增通用文件响应 helper 测试：二进制 body、媒体类型、RFC 5987 文件名、Content-Length。
   - 扩展 FBA 接口契约测试：响应 body 可作为 XLSX 打开、非 JSON、下载头正确；错误仍是 Agent JSON。
   - 为既有店铺测算 XLSX 导出补充 OpenAPI 二进制 schema 契约测试。
   - 运行新增测试，确认 helper 尚不存在时失败。
2. **实现共享 helper（GREEN）**
   - 新建 `backend/app/api/agent/file_response.py`。
   - 支持原始 bytes 文件载荷，使用 `StreamingResponse`、`Content-Length` 和安全的 RFC 5987 `Content-Disposition`。
   - 更新 FBA 和店铺测算 XLSX 路由使用 helper，移除重复文件名头构造函数并为两者声明 OpenAPI 二进制 schema。
   - 保留店铺测算导出现有审计记录与事务行为。
3. **固化文档规范**
   - 在 `docs/agent-api-design.md` 响应契约部分增加 Agent 文件型资源规范及 v0.12 修订记录。
   - 在 `backend/docs/agent-skills/README.md` 写明文档指针，并将 shipments 路由数从 11 更正为 12。
4. **验证**
   - 运行文件 helper 与 FBA 路由相关测试。
   - 运行 Agent 货件/OpenAPI 回归测试和 Alembic 静态检查。
   - 检查生成的 OpenAPI / TypeScript 声明将两条 XLSX 成功响应标记为二进制媒体类型。
   - 检查 diff，确认没有改动非 Agent 导出、前端业务页面或数据库迁移；只更新生成的 OpenAPI / TypeScript 契约文件。

## 预期文件

- `backend/app/api/agent/file_response.py`
- `backend/app/api/v1/endpoints/agent/shipments.py`
- `backend/app/api/v1/endpoints/agent/shop_calculations.py`
- `backend/tests/unit/test_agent_file_response.py`
- `backend/tests/api/agent/test_shipments_fba_template.py`
- `backend/tests/api/agent/test_shop_calc_read.py`
- `docs/agent-api-design.md`
- `backend/docs/agent-skills/README.md`
- `frontend/types/api-generated/openapi.json`
- `frontend/types/api-generated/api.d.ts`

## 风险与处理

- 文件名需兼容中文和 HTTP header 的 ASCII 限制：提供 ASCII fallback 与 RFC 5987 编码值，并测试引号/反斜杠等不安全字符。
- FastAPI 的响应文档容易因返回类型推断 JSON：显式保留 `response_model=None` 和文件媒体类型声明。
- Agent 认证/校验错误须在创建文件响应之前抛出，以继续返回标准 JSON 错误壳。

## 验证结果

- helper + FBA 路由专项：13 passed。
- 店铺测算导出 OpenAPI/文件回归：4 passed。
- Agent 货件/OpenAPI 扩展回归：73 passed；Alembic 检查通过；OpenAPI 与 TypeScript 声明同步。
- 前端 lint 通过、build 通过（含生成类型同步检查）。全量 Vitest 因单 worker 长时间高 CPU 且无进度而中断。
- 后端完整测试最终为 3754 passed、25 failed、14 skipped；25 项失败与此前 `origin/main` 基线记录的用例类别一致，涉及巡检、云存储、CRM、库存和依赖版本断言。
- 复核时曾出现的 Insight 409 已定位为测试辅助函数只在 200 个日期窗口内随机选幂等键，与持久化 `BLF_test` 中已有 `InsightRun` 冲突。测试现查询已占用键并选取空闲窗口，同时清理自身创建的 queued run；此前可复现的相邻测试顺序 51 passed，完整套件不再出现该额外失败。
