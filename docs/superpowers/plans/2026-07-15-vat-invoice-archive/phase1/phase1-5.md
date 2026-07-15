# 任务 phase1-5：迁移脚本 invoice_sellers JSON → vat_entities

> 源计划：[../plan.md](../plan.md)（任务标题在 plan.md 中搜索 `phase1-5`）
> 主追踪索引：[../tracking.md](../tracking.md)

## 涉及文件（来自 plan）
- 实现：backend/scripts/migrate_invoice_sellers_to_entities.py
- 测试：

## 计划步骤（执行时逐项勾选）
- [ ] 步骤 1：写失败测试
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现最小代码
- [ ] 步骤 4：跑测试确认通过
- [ ] 步骤 5：Commit（含 plan 里指定的 message）

## 实施记录
<!-- 执行者在此填写：commit SHA、偏离 plan 的取舍、遇到的坑 -->
- 2026-07-15 2cb51ebb 完成。`scripts/migrate_invoice_sellers_to_entities.py`：dry-run 默认 + `--commit` 写入 + 跳过空/无 context + 按 (project_id, country) 去重 + 已存在检测。本地 sqlite 验证 `extract_seller_plan`：弥森 DE+FR、Other DE、Dup 两个 DE（只留 first）、Empty（空列表跳过）、NoCtx（None 跳过）全部正确。去程。坑：`from app.db.session import SessionLocal` 路径修正（plan 原写 `app.db`，仓库实际 `app.db.session`）。
- 

## 审查
- [ ] 规格合规：代码匹配 plan（无缺失/多余）
- [ ] 代码质量：lint / type / 测试全绿，无魔法数字/死代码
