---
name: believeboy-sales
description: 调用 BelieveBoy Agent API 提取跨项目销售数据（sales 域，business_scope sales，1 条路由 GET /sales/summary）。用于销售汇总、ASIN×日明细、多站点聚合、取消/待定单口径、销售额份额。Use when the user asks for 销售数据 / 销售额 / 订单汇总 / sales summary / 销售报表, 或任何需要从 dash-api.believeboy.com 读取销售数据的任务。
---

# BelieveBoy Agent API · 销售数据（sales）

跨项目销售数据读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点（1 条读路由，business_scope "sales"）

`GET /api/v1/agent/projects/{project_id}/sales/summary`（BLF-569：旧路径 `/orders/summary` 已 v3 下线移除，**只认 sales/summary**）

```bash
# 汇总：近 30 天 US
curl -s "$BASE/projects/$PROJECT_ID/sales/summary?period=30d&country=US" "${AUTH[@]}"

# ASIN×日明细：近 30 天 + group_by 扩展 + 份额
curl -s "$BASE/projects/$PROJECT_ID/sales/summary?period=30d&country=US&group_by=asin_day&include_share=true" "${AUTH[@]}"

# 多站点聚合（BLF-560）：country 多值逗号分隔 + by_country 分站
curl -s "$BASE/projects/$PROJECT_ID/sales/summary?period=last_month&country=US,CA&aggregate=true" "${AUTH[@]}"
```

## 3. 参数

| 参数 | 说明 |
|---|---|
| `period` | 时间窗：`7d`/`14d`/`28d`/`30d`/`60d`/`90d`/`this_month`/`last_month`/`ytd`/`YYYY-MM`/`YYYY-MM-DD`/`custom`（配 start_date+end_date） |
| `start_date` / `end_date` | 自定义区间 |
| `country` | 2 字母，可**多值逗号分隔**（BLF-560 多站点聚合） |
| `include_cancelled` | bool，默认 false（不含取消单） |
| `include_pending` | bool，默认 true（含待定单） |
| `aggregate` | bool，默认 true（汇总）；false 出明细行 |
| `group_by` | `asin` / `asin_day` / `day`（BLF-557/558 扩展） |
| `order_by` / `order_dir` | 默认 `sales_amount` desc |
| `include_share` | bool，默认 false；true 时带销售额份额（share 口径） |
| `limit` | ≤50000；`offset` 默认 0 |

## 4. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("sales")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/sales.py`）
