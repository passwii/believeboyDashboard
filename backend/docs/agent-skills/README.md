# Agent Skills（业务域调用方法）

> 本目录是 BelieveBoy Agent API 业务域调用方法的仓库内固化版本。

## 用途

每个文件对应一个 `believeboy-*` skill：把 BelieveBoy Agent API 某个业务域的**调用方法**（鉴权 / 项目解析 / 端点 / 参数 / 响应要点 / 已知坑）写成可分配、可执行的 skill。

## 命名与约定

- **文件名 / skill 名**：`believeboy-<业务域>`，业务域与后端 Agent API 路由域一一对应（权威索引见 [`docs/agent-api-design.md`](../../../docs/agent-api-design.md)）
- **env 变量名（统一三件套）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认 `https://dash-api.believeboy.com/api/v1/agent`）
- **凭据纪律**：skill 内**禁止**写明文 Key——方法进 skill，凭据注入 Agent 的运行环境（skill 是可共享制品）

## 文件清单（13 个域 · 全部已建）

| 文件 | 业务域 | 路由数 | 说明 |
|---|---|---|---|
| `believeboy-sku-info.md` | sku-info（商品主数据） | 6（读3+写3） | R1 列表 / R2 详情 / R3 审计 / W1 upsert / W2 成本 / W3 上下架（写走 confirm 两步） |
| `believeboy-inventory-ledger.md` | inventory-ledger（库存台账） | 10（纯读） | months/snapshot/events/receipt-clusters/integrity/trend/detail/summary/batches/consistency；含已知线上 bug 与规避 |
| `believeboy-replenishment-analysis.md` | replenishment-analysis（补货分析） | 6 | R1 决策清单 / R2 单 SKU / R3 总览矩阵 / R4 覆盖度 / R5 设置读 / R6 设置写 confirm |
| `believeboy-ad-analysis.md` | ad（广告，10 模块） | 29（纯读） | 每模块 aggregate + raw + 单数 alias；campaigns/budgets/targets/placements/promoted/time_trends/search_terms/shares/invalid/purchased |
| `believeboy-shipments.md` | shipments（货件） | 11（读5+写6） | 列表/详情/SKU 汇总/箱规/审计；创建/items/改信息/状态/重算成本/删除（写全 confirm） |
| `believeboy-sales.md` | sales（销售数据） | 1 | GET /sales/summary（group_by/多站点聚合/份额，BLF-569 迁移后唯一入口） |
| `believeboy-shop-calculation.md` | shop_calculations（店铺测算，3 模块） | 9 | 原生 6（列表/详情/历史/审计/写/试算）+ BI 扁平 2 + 定价快照 1；含定价派生块 `anchor`（盈亏平衡/目标广告费率，BLF-1043） |
| `believeboy-account-health.md` | account_health（合规健康） | 5（纯读） | periods/current/overview/单店报告/history（路径不带 project_id） |
| `believeboy-inventory.md` | inventory（当前库存） | 1 | GET /inventory 当前库存快照（BLF-478，与台账/补货独立） |
| `believeboy-new-product-calculation.md` | new_product_calculations（新品测算） | 5 | 读3（列表/详情/审计）+ 写1 + 试算1；4 种 calculation_type；读与试算带 `anchor`（BLF-1043） |
| `believeboy-return-analysis.md` | return_analysis（退货分析） | 5（纯读） | overview/聚合/raw（PII 剥离）/单 SKU/coverage；R2 country 必填 |
| `believeboy-report-upload-status.md` | report_upload_status（报表上传状态） | 1 | GET /report-upload-status（report_date 必填；路径不带 project_id；BLF-486 缺报清单数据源） |
| `believeboy-platform-inspection.md` | platform_inspection（平台巡检·写侧） | 5（读1+写4） | R0 模板 / W1 upsert 草稿 / W2 提交（confirm）/ W3 截图上传 / W4 截图删除（confirm）；读侧走 account-health |

## 维护规约

1. **新增 skill**：确认对应 Agent API 域已具备稳定契约后，在本目录新增 `believeboy-<业务域>.md`
2. **修改 skill**：直接修改本目录文件，并随对应 Agent API 变更一起提交
3. **路由核对**：端点一律以 `backend/app/api/v1/endpoints/agent/` 源码为准（本仓库即权威），不凭记忆写
4. 本目录只有 `.md` 纯文本，改动不触发后端部署逻辑；如 push 触发 pre-push 部署可加 `SKIP_POST_PUSH_DEPLOY=1`
