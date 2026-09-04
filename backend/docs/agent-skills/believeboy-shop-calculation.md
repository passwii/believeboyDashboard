---
name: believeboy-shop-calculation
description: 调用 BelieveBoy Agent API 获取跨项目店铺测算数据（shop_calculations 域，business_scope shop_calculations，3 模块共 9 条路由：原生 shop-calculations 6 + BI 扁平 2 + 定价快照 1）。用于店铺测算当前态/历史/审计、追加快照、试算、定价目录冻结。Use when the user asks for 店铺测算 / 店铺核算 / shop calculation / 定价快照 / pricing snapshot / 试算, 或任何需要从 dash-api.believeboy.com 读取或写入店铺测算数据的任务。
---

# BelieveBoy Agent API · 店铺测算（shop-calculation）

跨项目店铺测算数据读取与写入方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（9 条 = 3 模块，同一 business_scope "shop_calculations"）

### 模块 A：原生 shop-calculations（BLF-442）

路径前缀：`/api/v1/agent/projects/{project_id}/shop-calculations`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/shop-calculations` | 当前态列表（每 SKU 最新有效行，软删过滤） |
| R2 | GET | `/shop-calculations/skus/{sku}` | SKU 详情：当前态最新行；country 缺省且多国家 → 400 AMBIGUOUS（需传 country 消歧） |
| R3 | GET | `/shop-calculations/skus/{sku}/history` | SKU 历史：append-only 全部版本（observed_at 倒序） |
| R4 | GET | `/shop-calculations/skus/{sku}/audit` | SKU 审计：按 SKU 聚合多行 target_id 的操作轨迹 |
| W1 | POST | `/shop-calculations` | 追加快照（**confirm 两步**，append-only 落一行 + 审计归因） |
| C1 | POST | `/shop-calculations/compute` | 试算：包装引擎纯计算（不落库、不落审计），返回 `{calculation, snapshot}` 双字段 |

### 模块 B：BI 扁平契约（BLF-582 原生化）

路径前缀：`/api/v1/agent/projects/{project_id}`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R5 | GET | `/shop-calculation-history` | 当前态列表：每 `(project_id, sku, country)` 组最新非删行，扁平 15 列 |
| R6 | GET | `/shop-calculation/snapshots` | append-only 时间序列：同一 SKU/country 组跨多个 observed_at 快照 |

### 模块 C：定价快照（BLF-582 原生化）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R7 | GET | `/pricing-snapshots` | 定价目录冻结：最近一次 `snapshot_date ≤ as_of` 的全 SKU 经济账 |

```bash
# 列表（当前态）
curl -s "$BASE/projects/$PROJECT_ID/shop-calculations" "${AUTH[@]}"

# SKU 详情（多国家需传 country 消歧）
curl -s "$BASE/projects/$PROJECT_ID/shop-calculations/skus/{sku}?country=US" "${AUTH[@]}"

# 试算（不落库）
curl -s -X POST "$BASE/projects/$PROJECT_ID/shop-calculations/compute" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{...输入参数...}'
```

## 3. 注意事项

- 读路由不落审计；W1 写走 confirm 两步 + 写限流；C1 试算不落库不落审计
- R2 多国家歧义 → 400 AMBIGUOUS：**必须显式传 country**
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("shop_calculations")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `agent/shop_calculations.py` / `agent/shop_calculation.py` / `agent/pricing_calculation_snapshots.py`）
