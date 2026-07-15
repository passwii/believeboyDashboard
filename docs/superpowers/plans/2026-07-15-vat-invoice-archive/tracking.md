# VAT 发票存档 — 任务追踪索引

> 每个任务一个骨架文件放在对应 phase/ 子目录，sub-agent 或内联执行时把进展/记录写进去，避免追踪失败。
> 计划主文档：`plan.md`

| 任务 | Phase | 骨架文件 | 状态 |
|---|---|---|---|
| phase1-1 纯函数 VAT 计算 + 测试 | 1 | [phase1/phase1-1.md](phase1/phase1-1.md) | [x] |
| phase1-2 Alembic 迁移 + 模型 | 1 | [phase1/phase1-2.md](phase1/phase1-2.md) | [x] |
| phase1-3 主体服务 + 端点 + 守卫 | 1 | [phase1/phase1-3.md](phase1/phase1-3.md) | [x] |
| phase1-4 projects.vat_enabled 接入 manage | 1 | [phase1/phase1-4.md](phase1/phase1-4.md) | [ ] |
| phase1-5 迁移脚本 invoice_sellers→entities | 1 | [phase1/phase1-5.md](phase1/phase1-5.md) | [x] |
| phase1-6 前端 seller-card 切 vat-entity-api | 1 | [phase1/phase1-6.md](phase1/phase1-6.md) | [ ] |
| phase2-1 发票服务 create/list/get/void | 2 | [phase2/phase2-1.md](phase2/phase2-1.md) | [ ] |
| phase2-2 发票端点 + PDF 上传 + 重下 + 作废 | 2 | [phase2/phase2-2.md](phase2/phase2-2.md) | [ ] |
| phase2-3 前端生成器 保存草稿 + 签发归档 | 2 | [phase2/phase2-3.md](phase2/phase2-3.md) | [ ] |
| phase3-1 历史列表页 + 详情 + CSV 导出 | 3 | [phase3/phase3-1.md](phase3/phase3-1.md) | [x] |
