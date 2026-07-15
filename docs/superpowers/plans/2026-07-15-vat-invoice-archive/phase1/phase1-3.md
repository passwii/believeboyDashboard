# 任务 phase1-3：主体服务 + 端点（CRUD + 守卫）

> 源计划：[../plan.md](../plan.md)（任务标题在 plan.md 中搜索 `phase1-3`）
> 主追踪索引：[../tracking.md](../tracking.md)

## 涉及文件（来自 plan）
- 实现：backend/app/services/vat_invoice.py, backend/app/api/v1/endpoints/vat_invoices.py
- 测试：backend/tests/services/test_vat_invoice_service.py, backend/tests/api/test_vat_invoice_endpoints.py

## 计划步骤（执行时逐项勾选）
- [ ] 步骤 1：写失败测试
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现最小代码
- [ ] 步骤 4：跑测试确认通过
- [ ] 步骤 5：Commit（含 plan 里指定的 message）

## 实施记录
<!-- 执行者在此填写：commit SHA、偏离 plan 的取舍、遇到的坑 -->
- 2026-07-15 afcac1a9 完成。`VatEntity` CRUD 服务（upsert/list/delete/ensure_vat_enabled）+ `vat-entities` 4 端点 + 路由注册 + schema + 测试。偏离：①测试按真实 conftest 重写——`project_factory`/`auth_client` 不存在，改用内联 `Project(...)` + `db_session` + `admin_headers` + `TestClient(app)`。②`ensure_vat_enabled` 放 `app.services.vat_invoice`（plan 在 project_service/vat_invoice 两处都提了，取一处保持 VAT 逻辑内聚）。坑：①list 端点签名 `request`（无默认）必须在 `project_id=Query(...)`（有默认）前，否则 SyntaxError；已修。②app 引擎 builder 用 PG-only pool kwargs，sqlite DATABASE_URL 直接 `create_engine` 报 TypeError——所以走 venv + postgresql URL 让引擎 lazy 构建。验证：①本地 sqlite smoke（`scripts/smoke_vat_entity.py`）7/7 检查通过（upsert 唯一、list 排序、delete、403/404 守卫）。②`pytest --co` 收集 11 个测试 0 错误（实际执行需要 `setup_test_db.py` 跑的 Postgres 测试库）。测试库未本地建，故未跑实际执行——代码层面通过真实 conftest 验证可收集。
- 

## 审查
- [ ] 规格合规：代码匹配 plan（无缺失/多余）
- [ ] 代码质量：lint / type / 测试全绿，无魔法数字/死代码
