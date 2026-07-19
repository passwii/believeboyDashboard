# VAT 发票存档 — 任务追踪索引

> 每个任务一个骨架文件放在对应 phase/ 子目录，sub-agent 或内联执行时把进展/记录写进去，避免追踪失败。
> 计划主文档：`plan.md`

| 任务 | Phase | 骨架文件 | 状态 |
|---|---|---|---|
| phase1-1 纯函数 VAT 计算 + 测试 | 1 | [phase1/phase1-1.md](phase1/phase1-1.md) | [x] |
| phase1-2 Alembic 迁移 + 模型 | 1 | [phase1/phase1-2.md](phase1/phase1-2.md) | [x] |
| phase1-3 主体服务 + 端点 + 守卫 | 1 | [phase1/phase1-3.md](phase1/phase1-3.md) | [x] |
| phase1-4 projects.vat_enabled 接入 manage | 1 | [phase1/phase1-4.md](phase1/phase1-4.md) | [x] |
| phase1-5 迁移脚本 invoice_sellers→entities | 1 | [phase1/phase1-5.md](phase1/phase1-5.md) | [x] |
| phase1-6 前端 seller-card 切 vat-entity-api | 1 | [phase1/phase1-6.md](phase1/phase1-6.md) | [x] |
| phase2-1 发票服务 create/list/get/void | 2 | [phase2/phase2-1.md](phase2/phase2-1.md) | [x] |
| phase2-2 发票端点 + PDF 上传 + 重下 + 作废 | 2 | [phase2/phase2-2.md](phase2/phase2-2.md) | [x] |
| phase2-3 前端生成器 保存草稿 + 签发归档 | 2 | [phase2/phase2-3.md](phase2/phase2-3.md) | [x] |
| phase3-1 历史列表页 + 详情 + CSV 导出 | 3 | [phase3/phase3-1.md](phase3/phase3-1.md) | [x] |

---

## 2026-07-18 验证收尾

全 10 任务代码已落地，本轮验证 + 修 2 个测试 bug：

**修的 bug：**
1. `backend/app/services/vat_invoice.py` `compute_invoice_totals`：lines 里的 `unit_price_incl_vat` / `qty` / `vat_rate` 若是 str（测试与端点都传过 str），`it['unit_price_incl_vat'] * it['qty']` 会变字符串拼接（`'119.00119.00'`）。函数入口统一 `Decimal()` / `int()` 转换。
2. `backend/tests/api/test_vat_invoice_endpoints.py`：4 处 seed 后只 `flush()` 没 `commit()`，导致 `TestClient`（走 app 自己的 `SessionLocal`）看不到未提交数据，`ensure_project_access` 报 404 "项目不存在"。补 `db_session.commit()`。
3. `backend/tests/services/test_vat_invoice_service.py`：`_seed_project_and_seller` / `_make_project` 用固定名 `'VATshop'` / `'SmokeShop'`，commit 后落库会撞 `projects_project_name_key` 唯一约束。改用 uuid 唯一名。

**验证结果：**
- 后端：`pytest tests/services/test_vat_invoice_math.py tests/services/test_vat_invoice_service.py tests/api/test_vat_invoice_endpoints.py` → **23/23 PASS**（需 `brew services start redis`，`/projects/manage` 依赖 Redis）
- 前端单测：`pnpm test` → **169/169 PASS**（含 VAT 4 个测试文件：vat-entity-api / vat-invoice-api / vat-history-api / invoice-history-table）
- 前端 lint：`pnpm lint` → **0 error**（25 warning，均与 VAT 无关）
- 前端 build：`pnpm build` → **✓ Compiled successfully**，`/dashboard/finance/vat-invoice` + `/dashboard/finance/vat-invoices` 两路由均编译通过

**端点完整性核对：**
- 主体：`GET/POST /vat-entities`、`PATCH/DELETE /vat-entities/{id}` ✅
- 发票：`POST /vat-invoices`、`GET /vat-invoices`、`GET /vat-invoices/{id}`、`POST /vat-invoices/{id}/pdf`、`GET /vat-invoices/{id}/pdf`、`POST /vat-invoices/{id}/void` ✅
- 前端生成器：`createInvoiceDraft`（保存草稿）+ `issueInvoice`（签发归档，两步上传 PDF 到 R2，draft→issued）✅
