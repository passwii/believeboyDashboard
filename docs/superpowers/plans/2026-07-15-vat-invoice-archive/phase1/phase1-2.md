# 任务 phase1-2：Alembic 迁移：vat_enabled + vat_entities + vat_invoices + vat_invoice_lines

> 源计划：[../plan.md](../plan.md)（任务标题在 plan.md 中搜索 `phase1-2`）
> 主追踪索引：[../tracking.md](../tracking.md)

## 涉及文件（来自 plan）
- 实现：backend/alembic/versions/<ts>_add_vat_enabled_and_vat_tables.py
- 测试：backend/app/models/project.py, backend/app/models/__init__.py

## 计划步骤（执行时逐项勾选）
- [ ] 步骤 1：写失败测试
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现最小代码
- [ ] 步骤 4：跑测试确认通过
- [ ] 步骤 5：Commit（含 plan 里指定的 message）

## 实施记录
<!-- 执行者在此填写：commit SHA、偏离 plan 的取舍、遇到的坑 -->
- 2026-07-15 a7e67252 完成。`VatEntity` / `VatInvoice` / `VatInvoiceLine` 模型 + `Project.vat_enabled` ORM 属性 + `models/__init__.py` 注册 + 手写 alembic 迁移 `20260715_001`（`down_revision='20260713_212'`）。`alembic heads`/`show`/`history` 通过；用 stub projects + `alembic_version='20260713_212'` 做隔离 DDL 验证：`projects.vat_enabled` BOOLEAN 列 / 3 表（12+21+11 列）/ `ck_vat_invoices_status` check / `idx_vat_entities_project` / seed (弥森=1, OtherShop=0) 全绿。坑：首次漏 `from alembic import op` 导致 `NameError`，已补。`invoice_no` 字段用 `String(64)`（plan 改 VAT 号后从 40 加宽）。全仓库早期迁移对 sqlite 不全兼容（PG-only 语法），故全链路 sqlite `upgrade head` 不可跑——真实验证靠 VPS `alembic upgrade head`（真 Postgres）。
-

## 审查
- [ ] 规格合规：代码匹配 plan（无缺失/多余）
- [ ] 代码质量：lint / type / 测试全绿，无魔法数字/死代码
