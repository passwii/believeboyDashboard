---
name: believeboy-shop-calculation
description: 调用 BelieveBoy Agent API 获取跨项目店铺测算数据（shop_calculations 域，business_scope shop_calculations，3 模块共 9 条路由：原生 shop-calculations 6 + BI 扁平 2 + 定价快照 1）。含定价派生块 anchor（盈亏平衡广告费率 / 目标广告费率，BLF-1043）。用于店铺测算当前态/历史/审计、追加快照、试算、定价目录冻结。Use when the user asks for 店铺测算 / 店铺核算 / shop calculation / 定价快照 / pricing snapshot / 试算 / 盈亏平衡广告费率 / breakeven ACOS, 或任何需要从 dash-api.believeboy.com 读取或写入店铺测算数据的任务。
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

（R1/R2/R3 行上另带定价派生块 `anchor`，W1 预览与 C1 也带 —— 见 §3）

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

（扁平行没有费用拆项，锚由服务端推成 4 个平铺列 —— 见 §3.1）

路径前缀：`/api/v1/agent/projects/{project_id}`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R5 | GET | `/shop-calculation-history` | 当前态列表：每 `(project_id, sku, country)` 组最新非删行，扁平行含 4 个 `anchor` 派生列 |
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

## 3. 定价派生块 `anchor`（BLF-1043）

判定「广告效率好不好」要拿**盈亏平衡广告费率**当分母（运营口径的「盈亏平衡 ACOS」）。
它在定价引擎里是纯代数（`advertising_rate` 只以 `sale_price_usd × advertising_rate`
的线性项出现，不进任何费率阶梯），所以由 API 算一次、所有消费方共用同一口径，
不要自己在本地用 `total_fee_usd` 二次减：

```text
non_ad_fee_usd            = total_fee_usd - advertising_fee_usd   # EU 三笔手动费已在 total_fee 内
breakeven_advertising_rate = 1 - (non_ad_fee_usd + ddp_cost_usd + vat_usd) / sale_price_usd
target_advertising_rate    = breakeven_advertising_rate - target_net_margin
```

免费自检恒等式：`breakeven_advertising_rate ≡ advertising_rate + profit_rate`
（残差 ≤ 约 `0.01 / sale_price_usd`，是引擎 2 位金额 / 4 位比率的舍入地板，不是公式误差）。

### 3.1 哪些路由带 `anchor`

| 路由 | 形态 |
|---|---|
| R1 / R2 / R3 | 每行嵌套块 `anchor`；`?include_anchor=false` 关闭（响应与旧版逐字节一致，键消失不是置 null） |
| W1 追加写 | **预览响应**带 `anchor`（写前就能看到锚，无需等落库）；确认后落库响应也带（该处 target 字段为 `null`） |
| C1 `/compute` | `calculation` 与 `snapshot` 两块都带 `anchor` |
| R5 / R6 / R7（BI 扁平） | 扁平行**没有费用拆项**，消费方自己算不出锚 —— 服务端推成四个平铺列：`breakeven_advertising_rate` / `non_ad_fee_usd` / `max_ad_spend_per_unit_usd` / `target_advertising_rate`；均支持 `?include_anchor=false`，默认 `true`，关闭时四列全部省略 |

### 3.2 字段

```json
{
  "anchor": {
    "breakeven_advertising_rate": 0.2980,
    "non_ad_fee_usd": 15.60,
    "max_ad_spend_per_unit_usd": 12.81,
    "breakeven_advertising_rate_after_vat": null,
    "target_net_margin": 0.10,
    "target_advertising_rate": 0.1980,
    "basis": {
      "observed_at": "2026-09-13T08:00:00+00:00",
      "usd_to_rmb_rate": 6.7894,
      "usd_to_rmb_rate_source": "manual"
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `breakeven_advertising_rate` | 盈亏平衡广告费率（比率，非百分数）；低价 SKU 上 1pt 就是百分之几相对误差，**用满 4 位小数** |
| `non_ad_fee_usd` | 锚的分母拆项 `total_fee_usd − advertising_fee_usd`；解释「为什么这个 SKU 锚只有 12.6%」必须看它 |
| `max_ad_spend_per_unit_usd` | `sale_price_usd × breakeven_advertising_rate`，打平前每单可用广告费上限（看钱比看比率直观） |
| `breakeven_advertising_rate_after_vat` | 含 VAT 口径；**US 返回 `null`**（不是 0，避免被误读成「美国有 VAT」） |
| `target_net_margin` / `target_advertising_rate` | 仅当调用方传 `target_net_margin` 时才有值，否则 `null`（API 不替调用方拍业务默认值） |
| `basis` | `observed_at` / `usd_to_rmb_rate` / `usd_to_rmb_rate_source` —— 锚随汇率漂移（实测同 SKU：fx 6.7894 → 29.80%，fx 6.7078 → 29.38%），**必须把 `anchor` 当自包含对象缓存与版本化** |

### 3.3 参数 `target_net_margin`

`ge=-1, le=1`（Query：R1/R2/R3 + R5/R6/R7；body：C1）。**不要传 `ge=0` 的思路**——
「清库存」档允许目标净利率为负（−10pt）。不传 → `target_net_margin` /
`target_advertising_rate` 均为 `null`。**W1 不接受该参数**（它不是快照字段）。

### 3.4 参数 `include_anchor`

R1/R2/R3 与 R5/R6/R7 都支持 `?include_anchor=false`，默认 `true`。
R1/R2/R3 关闭时移除嵌套 `anchor`；R5/R6/R7 关闭时移除四个扁平锚列。
字段必须缺席，不是置为 `null`。

### 3.5 注意事项

- **派生量，不写库**：读时计算，零迁移，append-only 语义不变。
- **不 clamp**：闭式解 ≤ 0（成本已高于售价，不花广告费也亏）**原样返回负值** —— 负值本身是诊断信号；≥ 1 原样返回。
- `sale_price_usd == 0` → `null`（返回 0 会被读成「广告一分不能花」）。
- 退货损失 `return_loss_usd` 是**期望值**，所以锚是「按当前退货率假设的期望锚」，不是「零退货锚」。
- 锚派生自**该行自己的费用字段**（agent 可写）→ 恒等式残差超过 `0.01 / price` 说明这一行的费用拆项本身不自洽。

## 4. 注意事项

- 读路由不落审计；W1 写走 confirm 两步 + 写限流；C1 试算不落库不落审计
- R2 多国家歧义 → 400 AMBIGUOUS：**必须显式传 country**
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("shop_calculations")`
- 完整契约：believeboyDashboard [`backend/docs/agent-api.md`](../agent-api.md) §店铺测算域 + OpenAPI/Swagger（`/docs`）；
  模块源码 `agent/shop_calculations.py` / `agent/shop_calculation.py` / `agent/pricing_calculation_snapshots.py`
