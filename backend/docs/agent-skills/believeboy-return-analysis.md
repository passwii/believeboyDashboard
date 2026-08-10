---
name: believeboy-return-analysis
description: 调用 BelieveBoy Agent API 获取跨项目退货分析数据（return-analysis 域，business_scope return_analysis，5 条纯读路由）。用于退货全量分析/单 SKU 钻取/原始事件（PII 剥离）/数据覆盖度。Use when the user asks for 退货分析 / 退货率 / return analysis / 退货原因, 或任何需要从 dash-api.believeboy.com 读取退货分析数据的任务。
---

# BelieveBoy Agent API · 退货分析（return-analysis）

跨项目退货分析数据读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（5 条纯读，business_scope "return_analysis"）

路径前缀：`/api/v1/agent/projects/{project_id}`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/return-analysis/overview` | 全量退货分析（与内部同构的双段式：缓存 → snapshot-or-fallback）；**start_date / end_date 必填**（YYYY-MM-DD，仅格式校验） |
| R2 | GET | `/return-analysis` | per-SKU 聚合（查询契约与 external §9 完全一致）；**country 必填**（缺省 → 400 VALIDATION_FAILED "country is required"） |
| R3 | GET | `/return-analysis-raw` | raw 退货事件（**PII 剥离契约**：永不返回个人信息） |
| R4 | GET | `/return-analysis/skus/{sku}` | 单 SKU 钻取：R1 overview 的薄切片；start_date / end_date 必填 |
| R5 | GET | `/return-analysis/coverage` | 数据覆盖度 / 快照新鲜度：报表上传历史 + 数据跨度 + snapshot freshness |

```bash
# R1 全量分析（start/end 必填）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis/overview?start_date=2026-07-01&end_date=2026-07-31" "${AUTH[@]}"

# R2 per-SKU 聚合（过滤 + 排序 + 分页）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis?period=last_month&country=US&min_return_rate=0.1&risk_level=high&limit=50&offset=0&order_by=return_quantity&order_dir=desc" "${AUTH[@]}"

# R3 raw 事件（PII 剥离，分页）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis-raw?period=30d&country=US&limit=100" "${AUTH[@]}"
```

**R2 参数**：`country`（**必填**）/ `period`（同共享 period 语法）/ `start_date` / `end_date` / `sku`（子串）/ `min_return_rate`（float）/ `risk_level` / `limit`（默认 50，≤500）/ `offset` / `order_by`（默认 return_quantity）/ `order_dir`（asc|desc）。

## 3. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- **R3 raw 永不返回 PII**（姓名/地址等个人信息剥离）——这是契约，不要期待原始买家信息
- R1/R4 的 start_date/end_date 只卡格式不卡语义（如 `2026-13-99` 能过 Query 校验）——业务上还是传合法日期
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("return_analysis")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/return_analysis.py`）
