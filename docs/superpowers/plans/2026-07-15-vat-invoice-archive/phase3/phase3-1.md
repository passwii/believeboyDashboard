# 任务 phase3-1：dashboard/finance/vat-invoices 列表页（Server + Client）+ CSV 导出

> 源计划：[../plan.md](../plan.md)（任务标题在 plan.md 中搜索 `phase3-1`）
> 主追踪索引：[../tracking.md](../tracking.md)

## 涉及文件（来自 plan）
- 实现：frontend/app/dashboard/finance/vat-invoices/*
- 测试：frontend/app/dashboard/finance/vat-invoices/**/*.test.tsx

## 计划步骤（执行时逐项勾选）
- [ ] 步骤 1：写失败测试
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现最小代码
- [ ] 步骤 4：跑测试确认通过
- [ ] 步骤 5：Commit（含 plan 里指定的 message）

## 实施记录
<!-- 执行者在此填写：commit SHA、偏离 plan 的取舍、遇到的坑 -->
- 2026-07-15 45bb01a8 完成。`/dashboard/finance/vat-invoices` 历史页（Server + Client）+ `vat-history-api`（listInvoices / getInvoiceDetail / voidInvoice / downloadInvoicePdf window.open / exportInvoicesCsv）+ `InvoiceHistoryTable`（带状态/作废/下载按钮）+ `InvoiceDetailDialog`（拉详情 + 明细行 + 按 VAT 率汇总 + 状态徽标）+ 侧栏 `lib/sidebar-config.ts` 新增「VAT 发票历史」入口。测试：vitest 8/8（vat-history-api 5 + invoice-history-table 3）通过；tsc 全 VAT 区零错误。偏离：①toolbar 折进 client（`vat-invoices-client.tsx` 内含筛选 + 导出 + 列表）；②侧栏入口未做"任一店铺 vat_enabled 才显示"的运行时 gating（侧栏是静态配置，做 gating 需在 shell 拉 projects 接口，超出本任务范围；页面本身已按 `vat_enabled` 过滤店铺下拉）。坑：①`fetchProjectsManage` 相对路径写错成 `../../vat-invoice/...`（应为 `../vat-invoice/...`）→ tsc 报模块未找到，已修。②`has_pdf` 字段不在详情 schema 上（只在 ListItem），详情 dialog 改用 `Boolean(detail?.r2_url)`。③`exportInvoicesCsv` 类型 cast 加 `as unknown as Record`。
- 

## 审查
- [ ] 规格合规：代码匹配 plan（无缺失/多余）
- [ ] 代码质量：lint / type / 测试全绿，无魔法数字/死代码
