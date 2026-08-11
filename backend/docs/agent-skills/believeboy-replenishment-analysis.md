---
name: believeboy-replenishment-analysis
description: 调用 BelieveBoy Agent API 获取跨项目补货分析（replenishment-analysis 域，6 条路由：R1 决策清单 / R2 单 SKU 深挖 / R3 项目总览 / R4 覆盖度 / R5 设置读 / R6 设置写 confirm）。用于补货建议、库存状态分布（critical/deteriorating/watch/healthy/unknown）、行动建议（REPLENISH_NOW 等）、decision_path 决策解释、数据新鲜度评估、补货设置维护。Use when the user asks for 补货分析 / 补货建议 / replenishment / 断货风险 / REPLENISH_NOW / 补货设置 / 库存状态分布, 或任何需要从 dash-api.believeboy.com 读取补货分析数据的任务。
---

# BelieveBoy Agent API · 补货分析（replenishment-analysis）

跨项目补货分析（决策清单 / 单 SKU 深挖 / 总览分布 / 覆盖度 / 设置读写）调用方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（6 条，BLF-502 v0.3 实施）

路径前缀：`/api/v1/agent/projects/{project_id}/replenishment-analysis*`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/replenishment-analysis` | 决策清单：全量逐 SKU 分析（三段式过滤 + 排序 + 响应瘦身 + 分页） |
| R2 | GET | `/replenishment-analysis/skus/{sku}` | 单 SKU 深挖：完整行 + signals + decision_path |
| R3 | GET | `/replenishment-analysis/summary` | 项目总览：state×action 分布矩阵 + 关键指标 |
| R4 | GET | `/replenishment-analysis/coverage` | 数据覆盖度/新鲜度：快照 report_date + 销售跨度 + 设置覆盖 + unknown_rate |
| R5 | GET | `/replenishment-analysis/settings?sku=` | 补货设置列表（配置审计） |
| R6 | PUT | `/replenishment-analysis/settings/{sku}` | 补货设置写（**confirm 流**） |

## 3. R1 决策清单参数

```bash
curl -s "$BASE/projects/$PROJECT_ID/replenishment-analysis" "${AUTH[@]}" \
  -G --data-urlencode "country=US" \
     --data-urlencode "inventory_state=critical,deteriorating" \
     --data-urlencode "replenishment_action=REPLENISH_NOW" \
     --data-urlencode "detail=summary" \
     --data-urlencode "order_by=available_inventory" \
     --data-urlencode "order_dir=asc" \
     --data-urlencode "page=1" --data-urlencode "page_size=50"
```

| 参数 | 说明 |
|---|---|
| `country` | 默认 `US` |
| `keyword` | SKU/ASIN 子串过滤（大小写不敏感） |
| `inventory_state` | 状态多值（逗号分隔）：`critical` / `deteriorating` / `watch` / `healthy` / `unknown` |
| `replenishment_action` | 行动多值（逗号分隔）：`REPLENISH_NOW` / `REPLENISH_NORMAL` / `HOLD` / `REDUCE_PRICE` / `REMOVE` / `NO_ACTION` |
| `risk_status` | 老 4 类风险过滤（兼容既有消费者；新消费者优先用 state/action）：断货风险\|短期断货\|长期断货\|健康库存\|滞销\|严重滞销\|待补数据。**BLF-630 起锚点改为下单缓冲**：短期断货=已过最晚下单日；断货风险=14 天内必须下单（见下注） |
| `in_transit_only` | bool，仅看有在途 |
| `report_date` | 业务日期 YYYY-MM-DD，取该日或之前最近的库存快照；缺省最新 |
| `order_by` | 白名单：`sku` / `available_inventory` / `in_transit_quantity` / `weighted_dms` / `sellable_days` / `estimated_replenishment_quantity` / `risk_status` / `inventory_state` / `replenishment_action` / `order_buffer_days` / `coverage_end_date`（BLF-630 新增） |
| `order_dir` | `asc` / `desc`（默认 asc） |
| `detail` | `summary`（默认，轻量核心决策字段，省 token）/ `full`（完整行 + signals + decision_path） |
| `page` / `page_size` | page_size ≤ 200 |

**`detail=summary` 保留的核心决策字段**：sku / asin / product_name / available_inventory / in_transit_quantity / weighted_dms / sellable_days / estimated_replenishment_quantity / inventory_state / replenishment_action / risk_status / replenishment_order_date / order_buffer_days / coverage_end_date（后两个 BLF-630 新增）。

> **BLF-630 判定口径变更（2026-08-11）**：`risk_status` 与 `inventory_state` 增加补货周期维度——锚点改为**下单缓冲** `order_buffer_days = 连续覆盖截止日(coverage_end_date) − (production_lead_days + shipping_days) − today`；`coverage_end_date` 为可售 + 在途批次（按 eta_date 时间线）的**连续覆盖截止日**（断档即截止）。`inventory_state` 新增 rule 码 `P0a`（watch）/ `P0b`（deteriorating，趋势走弱）——已过最晚下单日时触发。断档（`gap_days > 0`）如实告警，不忽略。

非法过滤值 / order_by / detail → 400 VALIDATION_FAILED（响应含合法值列表）。

## 4. 响应要点

- **R1**：`{ items, summary, page, page_size, total, has_next }`；`summary` 含 `state_distribution` / `action_distribution` / `state_action_matrix`（S6/G5）。
- **R2**：无该 SKU → **200 + `data: null`**（查询为空 ≠ 资源不存在，勿当 404）。
- **R4 coverage**：`inventory_snapshot{report_date, freshness_days, is_current}` + `sales_data`（销售跨度）+ `base_skus{total_count, configured_count}` + `unknown_rate`——Agent 用它判断"这份分析是否可信"。
- **decision_path**（detail=full 才有）：解释该 SKU 的补货决策链路（G1 可解释性）。
- **R6 写**：body `{asin?, production_lead_days, shipping_days, safety_factor}`（后三个必填非负数字）；confirm 流：第一步返回 `confirm_token` 不落库 → 用户确认后**同一 URL + 同一 Idempotency-Key** 重放 + `X-Confirm-Token`；审计 action `inventory_replenishment_settings.upsert`。

## 5. 注意事项

- 读为主域（无物化表，实时分析）：读路由无 confirm、不落审计；**R6 写走 confirm + 写限流**
- 全量路由挂 `require_project_scope`（BLF-441 硬前置）+ 域级 `business_scope("replenishment_analysis")`
- 已知修复：BEL-369 遗留的 seasonal YoY 窗口泄漏 bug（当年数据混入去年同期 → seasonal_factor 系统性偏低）已在 PR #166 修复，**勿按旧逻辑假设**
- 限流：读 300 次/分、写 30 次/分；**5xx** 一次性报告给报告 owner（Yawei），不要盲目重试
- 完整 spec：`docs/superpowers/specs/2026-08-07-agent-replenishment-analysis-api.md`（v0.3）
