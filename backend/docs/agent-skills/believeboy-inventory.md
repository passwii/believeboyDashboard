---
name: believeboy-inventory
description: 调用 BelieveBoy Agent API 获取跨项目当前库存快照（inventory 域，business_scope inventory，1 条读路由 GET /inventory）。用于当前库存信息（总量/库龄/缺货/单 SKU 数量）、与补货/台账区分。Use when the user asks for 当前库存 / 库存快照 / 库存数量 / inventory, 或任何需要从 dash-api.believeboy.com 读取当前库存数据的任务。
---

# BelieveBoy Agent API · 当前库存（inventory）

跨项目当前库存快照读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点（1 条读路由，business_scope "inventory"）

`GET /api/v1/agent/projects/{project_id}/inventory`（BLF-478，与内部 `/api/v1/inventory-analysis` 同构）

```bash
# 当前库存（summary + items + report_date）
curl -s "$BASE/projects/$PROJECT_ID/inventory" "${AUTH[@]}"

# 指定业务日期（取该日或之前最近快照）
curl -s "$BASE/projects/$PROJECT_ID/inventory?report_date=2026-08-01" "${AUTH[@]}"
```

**响应要点**：`report_date`（快照日期）+ `summary`（总量/库龄/缺货等聚合）+ `items`（SKU 级数量）。

> **与其它库存域的边界**：本域 = 当前库存快照（复用 inventory-analysis 的 service 与 Redis 缓存）；`inventory-ledger` = 库存台账（月度盘点/事件/收货簇/完整性/趋势，直查 inventory_ledger 表族）；`replenishment-analysis` = 补货建议（DMS/断货风险）。业务定位与路径均独立，无重叠。

## 3. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("inventory")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/inventory.py`）
