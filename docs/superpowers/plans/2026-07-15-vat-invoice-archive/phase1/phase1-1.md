# 任务 phase1-1：纯函数 split_vat / compute_invoice_totals + 测试

> 源计划：[../plan.md](../plan.md)（任务标题在 plan.md 中搜索 `phase1-1`）
> 主追踪索引：[../tracking.md](../tracking.md)

## 涉及文件（来自 plan）
- 实现：backend/app/services/vat_invoice.py
- 测试：backend/tests/services/test_vat_invoice_math.py

## 计划步骤（执行时逐项勾选）
- [ ] 步骤 1：写失败测试
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现最小代码
- [ ] 步骤 4：跑测试确认通过
- [ ] 步骤 5：Commit（含 plan 里指定的 message）

## 实施记录
- 2026-07-15 ed6c6630 完成。纯函数 `split_vat` / `compute_invoice_totals` 落地 `backend/app/services/vat_invoice.py`，2 测试通过（19% 拆分 + 双率含运费分桶合计 368.00）。无偏离。
- 

## 审查
- [ ] 规格合规：代码匹配 plan（无缺失/多余）
- [ ] 代码质量：lint / type / 测试全绿，无魔法数字/死代码
