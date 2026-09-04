---
name: believeboy-ad-analysis
description: 调用 BelieveBoy Agent API 提取跨项目广告分析数据（ad 域，business_scope ad_analysis，10 模块 29 条读路由）。用于广告投放活动/预算/目标/展示位/推广商品/时间趋势/搜索词/搜索词份额/无效流量/已购商品的分析与诊断（aggregate 聚合 + raw 原始行）。Use when the user asks for 广告分析 / 广告数据 / ad campaigns / 广告预算 / 搜索词 / 投放目标 / PPC / ACoS, 或任何需要从 dash-api.believeboy.com 读取广告数据的任务。
---

# BelieveBoy Agent API · 广告分析（ad-analysis）

跨项目广告分析数据读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（10 模块 × 3 读路由 = 29 条，business_scope "ad_analysis"）

路径前缀：`/api/v1/agent/projects/{project_id}/`

每个 ad 模块统一三形态（BLF-580/581 原生化样板，**全读**）：

| 形态 | 路径 | 用途 |
|---|---|---|
| aggregate | `/{module}` | 按业务键汇总 spend / sales / orders 等 |
| raw 复数 | `/{module}-raw` | 深诊断原始行（与删前 external handler 同契约） |
| raw 单数 alias | `/{module 单数}-raw` | 镜像时代路径面，保留不漂移 |

**模块清单**（aggregate 复数路径 / raw / 单数 alias）：

| 模块 | aggregate 路径 | 单数 alias |
|---|---|---|
| 投放活动 campaigns | `/ad-campaigns` | `/ad-campaign-raw` |
| 预算 budgets | `/ad-budgets` | `/ad-budget-raw` |
| 投放目标 targets | `/ad-targets` | `/ad-target-raw` |
| 展示位 placements | `/ad-placements` | `/ad-placement-raw` |
| 推广商品 promoted_products | `/ad-promoted-products` | `/ad-promoted-product-raw` |
| 时间趋势 time_trends | `/ad-time-trends` | `/ad-time-trend-raw` |
| 搜索词 search_terms | `/ad-search-terms` | `/ad-search-term-raw` |
| 搜索词份额 search_term_shares | `/ad-search-term-shares` | `/ad-search-term-share-raw` |
| 无效流量 invalid_traffic | `/ad-invalid-traffic`（仅 2 条：aggregate + raw，无单数 alias） | — |
| 已购商品 purchased_products | `/ad-purchased-products` | `/ad-purchased-product-raw` |

## 3. 调用参数（各形态通用）

```bash
# aggregate 示例：campaigns 近 30 天 US
curl -s "$BASE/projects/$PROJECT_ID/ad-campaigns?period=30d&country=US" "${AUTH[@]}"

# raw 示例：campaigns 原始行 + 分页排序
curl -s "$BASE/projects/$PROJECT_ID/ad-campaigns-raw?period=30d&country=US&limit=100&offset=0&order_by=report_end_date&order_dir=desc" "${AUTH[@]}"
```

| 参数 | aggregate | raw | 说明 |
|---|---|---|---|
| `period` | ✓ | ✓ | 时间窗（语法见 §4）；缺省 = 全部历史 |
| `start_date` / `end_date` | ✓ | ✓ | 自定义区间（配 `period=custom` 或替代 period） |
| `country` | ✓ | ✓ | 2 字母，缺省 = 全部 |
| `limit` | — | ✓ | 默认 10000，≤50000 |
| `offset` | — | ✓ | 默认 0 |
| `order_by` / `order_dir` | — | ✓ | 默认 `report_end_date` desc |

## 4. period 语法（与库存台账共享解析层 parse_period_v2）

`7d` / `14d` / `28d` / `30d` / `60d` / `90d` / `this_month` / `last_month` / `ytd` / `YYYY-MM` / `YYYY-MM-DD` / `custom`（配 start_date+end_date）。非法值 → 400。

## 5. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分（写 30 次/分按 agent 计）
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计（项目不存在先验 projects 解析）
- 所有模块挂 `require_project_scope`（BLF-441 硬前置）+ `business_scope("ad_analysis")`——Agent 需被授予该 scope
- 完整契约与响应 schema：believeboyDashboard 仓库 `docs/agent-api-design.md` v0.4 + OpenAPI（模块文件 `backend/app/api/v1/endpoints/agent/ad_*.py`）
