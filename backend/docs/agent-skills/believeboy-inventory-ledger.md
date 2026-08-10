---
name: believeboy-inventory-ledger
description: 调用 BelieveBoy Agent API 提取跨项目库存台账（inventory-ledger 域，10 条纯读路由）。用于月度盘点 EOM 对账、SKU 期末余额与库龄、入库事件聚合（Receipts/Shipments/Returns/Damaged/Lost/Disposed）、收货簇识别、跨月完整性校验、多月趋势、事件级明细/日水位汇总、CSV 导入溯源。Use when the user asks for 库存台账 / 月度盘点 / inventory-ledger / snapshot / 库位 / 完整性校验 / EOM 对账 / 库存事件 / 收货簇 / 库龄趋势, 或任何需要从 dash-api.believeboy.com 读取库存分类账数据的任务。
---

# BelieveBoy Agent API · 库存台账（inventory-ledger）

跨项目库存台账（月度盘点 / 事件 / 收货簇 / 完整性 / 趋势）读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

## 0. 凭据来源与鉴权（每次请求缺一不可）

> **workspace env 变量名约定（统一）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认）。各 agent 的 custom_env 按此三件套配置，skill 内一律引用这三个名字，禁止硬编码/明文 Key。

```bash
KEY="${AGENT_KEY}"                  # 明文 Key，agent custom_env 注入
AGENT_ID="${AGENT_ID}"              # X-Agent-Id 业务主键，如 operator-manager-Damon
BASE="${API_BASE:-https://dash-api.believeboy.com/api/v1/agent}"
AUTH=(-H "Authorization: Bearer $KEY" -H "X-Agent-Id: $AGENT_ID")
```

## 1. 项目名 → ID 解析（派发只给项目名，先查 ID）

```bash
curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}"
# → {"ok":true,"data":[{"project_id":1,"project_name":"<项目名>"}]}
PROJECT_ID=$(curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}" | jq -r '.data[0].project_id')
```

项目名以系统为准（共 13 个），未命中先向派发方确认，不猜。

## 2. 端点目录（10 条纯读，BLF-582 原生化）

路径前缀：`/api/v1/agent/projects/{project_id}/inventory-ledger/*`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 1 | GET | `/months` | 有台账数据的月份列表（YYYY-MM-DD，每月 1 号） |
| 2 | GET | `/snapshot?period=` | 月度快照：SKU EOM + 处置汇总 + 完整性 |
| 3 | GET | `/events?period=` | SKU 事件流：周期内每 SKU 各事件列合计 |
| 4 | GET | `/receipt-clusters?period=` | 收货簇：按（日期 × 仓库）归组收货 |
| 5 | GET | `/integrity?period=` | 跨月完整性校验（**必须整月**） |
| 6 | GET | `/trend?months=N` | 多月趋势（默认 6，最大 24） |
| 7 | GET | `/detail?period=&msku=&fulfillment_center=&event_type=` | 事件级明细行（Detailed 视图） |
| 8 | GET | `/summary?period=&msku=&location=&disposition=` | 日水位行（Summary 视图） |
| 9 | GET | `/batches?limit=` | CSV 导入批次溯源（limit 默认 100，≤500） |
| 10 | GET | `/consistency?period=` | 跨表一致性校验 Detail vs Summary（**必须整月**） |

## 3. `?period=` 语法（唯一输入约定）

| 值 | 窗口 | 备注 |
|---|---|---|
| `7d` / `14d` / `28d` / `30d` / `60d` / `90d` | 以 T-1 为锚的滑动窗口 | 不跑完整性 |
| `this_month` / `last_month` / `ytd` | 自然月 / 上月 / 年初至今 | 整月 → 跑完整性 |
| `YYYY-MM` / `YYYY-MM-DD` | 指定自然月（日被忽略） | 整月 → 跑完整性 |
| `custom` | 自定义区间 | **必须**同时传 `start_date` + `end_date` |

- `start_date` / `end_date` 只允许配 `period=custom`，否则 400
- `integrity` / `consistency` 只接受解析为整月的 period（部分窗口 → 400）
- `snapshot` 在整月窗口会自动附带 `integrity` 字段

## 4. 常用调用配方

```bash
# 对账上月（最常用）：EOM + 完整性 + 处置分布
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/snapshot?period=last_month" "${AUTH[@]}" \
  | jq '{report_month, sku_count, total_qty, integrity: .integrity.status, disposition_summary}'

# 指定月事件（top 收货 SKU）
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/events?period=2026-01" "${AUTH[@]}" \
  | jq '.skus | sort_by(-.total_receipts) | .[0:10]'

# 近 30 天（无完整性校验）
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/events?period=30d" "${AUTH[@]}"

# 自定义区间
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/events?period=custom&start_date=2026-01-01&end_date=2026-03-31" "${AUTH[@]}"

# 先发现可用月份，再逐月对账
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/months" "${AUTH[@]}"
# → {"project_id":1,"months":["2026-06-01","2026-05-01",...]}

# 6 个月趋势（含 damaged_pct，>5% 标记风险）
curl -s "$BASE/projects/$PROJECT_ID/inventory-ledger/trend?months=6" "${AUTH[@]}" \
  | jq '.months[] | {report_month, total_qty_eom, damaged_pct}'
```

**响应要点**：`report_month`（解析后周期起点）、`integrity.status`（OK/MISMATCH/PENDING，PENDING=上月无数据）、`skus[].qty_eom`、`skus[].change`（仅整月有）、`clusters[].cluster_id`（SKU 集合的 MD5，按 (日期,仓库) 分组）。

## 5. 反模式（400 / 422）

- ❌ 缺 `period` → 422 "Field required"
- ❌ 旧参数 `?report_month=` → 422（已移除）
- ❌ `period=last_month&start_date=...` → 400（period 不能与 start/end 组合，除非 custom）
- ❌ `period=foo` → 400（未知别名）
- ❌ `period=custom` 不带 start_date/end_date → 400
- ❌ `start_date > end_date` → 400

## 6. 已知线上 bug（2026-08-03 记录，未修）

**`snapshot?period=<整月>` 在项目上月有数据时返回 500**：`check_ledger_integrity`（`backend/app/services/inventory/ledger.py:491-512`）的 correlated subquery 把 `min(date)` 放进 WHERE，Postgres 报 `GroupingError`。**规避**：① 用 `period=custom` 双月窗口跳过完整性；② 或直接调 `/events` 拿数据；③ 需要完整性时单独调 `/integrity`（同样受影响）。涉及完整性的调用失败时**不要盲目重试**，按 §7 上报。

## 7. 注意事项

- 读路由不落审计；限流：读 300 次/分、写 30 次/分（按 X-Agent-Id 计）
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计（项目不存在先验 projects 解析）；未知 project_id 的 `/months` 返回 200 + `[]`、`skus[]` 为空——这是设计不是错误
- 完整 schema：`backend/app/schemas/inventory_ledger.py`；period 解析共享层 `inventory_ledger_common.resolve_period_inputs`
