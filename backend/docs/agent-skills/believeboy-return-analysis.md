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
| --- | --- | --- | --- |
| R1 | GET | `/return-analysis/overview` | 全量退货分析（与内部同构的双段式：缓存 → snapshot-or-fallback）；**start_date / end_date 必填**（YYYY-MM-DD，仅格式校验） |
| R2 | GET | `/return-analysis` | per-SKU 聚合（查询契约与 external §9 完全一致）；**country 与 period 都必填** |
| R3 | GET | `/return-analysis-raw` | raw 退货事件（**PII 剥离契约**：永不返回个人信息）；**period 必填** |
| R4 | GET | `/return-analysis/skus/{sku}` | 单 SKU 钻取：`summary` 与 `ranking_rows[0]` 同口径；start_date / end_date 必填 |
| R5 | GET | `/return-analysis/coverage` | 数据覆盖度 / 快照新鲜度：报表上传历史 + 数据跨度 + snapshot freshness |

> **三路口径一致（BLF-1078 修复）**：同一项目 + 同一窗口下
> `R1.summary.total_quantity == R2.summary.total_return_quantity == R3 行数`，
> 且 `R1.summary.total_sales_quantity == R2.summary.total_sales_quantity`。
> R1/R2/R3 同读「当前生效（`is_current`）退货报表」的 raw 行，不再让 R2 读
> 物化缓存（那份缓存只覆盖每日任务处理过的 (SKU, 日)，会让 R2 系统性偏低）。

### 必填参数（参数缺失时返回 400 VALIDATION_FAILED）

| 路由 | 必填 | 说明 |
| --- | --- | --- |
| R1 | `start_date` + `end_date` | 纯日期区间，不认 `period` |
| R2 | `country` + `period` | `period=custom` 时需同时给 `start_date` + `end_date` |
| R3 | `country` + `period` | 只认 `period`，不接受裸日期区间 |
| R4 | `start_date` + `end_date` | 同 R1 |
| R5 | `country` | — |

```bash
# R1 全量分析（start/end 必填）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis/overview?start_date=2026-07-01&end_date=2026-07-31" "${AUTH[@]}"

# R1 自定义窗口的完整日期区间（period=custom 亦可）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis/overview?start_date=2026-01-01&end_date=2026-09-14" "${AUTH[@]}"

# R2 per-SKU 聚合（period 与 country 都必填；过滤 + 排序 + 分页）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis?period=custom&start_date=2026-01-01&end_date=2026-09-14&country=US&min_return_rate=5&limit=50&offset=0&order_by=return_quantity&order_dir=desc" "${AUTH[@]}"

# R3 raw 事件（period 必填；PII 剥离，分页）
curl -s "$BASE/projects/$PROJECT_ID/return-analysis-raw?period=30d&country=US&limit=100" "${AUTH[@]}"
```

**R2 参数**：`country`（**必填**）/ `period`（同共享 period 语法）/ `start_date` / `end_date` / `sku`（子串）/ `min_return_rate`（float）/ `risk_level` / `limit`（默认 50，≤500）/ `offset` / `order_by`（默认 return_quantity）/ `order_dir`（asc|desc）。

### 可信度字段（BLF-1078，R1/R4 的 `summary`）

| 字段 | 含义 |
| --- | --- |
| `overall_return_rate` | 整体退货率（%）。**始终是数值**（与本仓库 Web 路由共用 schema）。若 `data_available=false`，该值不可信，不要引用。 |
| `data_available` | `false` = 本窗口与退货数据跨度无交集（或无任何退货数据）——先看它再采信率 |
| `data_span` | 该店退货数据的实际区间（`min_return_date` / `max_return_date`，不受本窗口限制） |
| `ranking_truncated` / `ranking_total_count` | 榜单是否被硬上限（20）截断及截断前总量；`true` 时尾部 SKU 未返回，需缩小窗口或改用 R2 分页 |

> **不要用 `risk_level` 过滤「高风险 SKU」**：`risk_level="no_data"` 表示**销量样本不足**（销量 < 15，Wilson 判定不可靠），不是「无退货」。退货率极高的长尾单品（如 200%、53.85%）也会被标为 `no_data`。改用 `return_rate` + `confidence`（`low` = 样本不足）。

```bash
# 无数据窗口：先看 data_available，再决定是否引用退货率
curl -s "$BASE/projects/$PROJECT_ID/return-analysis/overview?start_date=2025-01-01&end_date=2025-12-31" "${AUTH[@]}" \
  | jq '.data.summary | {overall_return_rate, data_available, data_span}'
```

## 3. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- **R3 raw 永不返回 PII**（姓名/地址等个人信息剥离）——这是契约，不要期待原始买家信息
- R1/R4 的 start_date/end_date 只卡格式不卡语义（如 `2026-13-99` 能过 Query 校验）——业务上还是传合法日期
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("return_analysis")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/return_analysis.py`）
