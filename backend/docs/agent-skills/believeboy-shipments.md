---
name: believeboy-shipments
description: 调用 BelieveBoy Agent API 查询与维护跨项目货件（shipments 域，business_scope shipments，11 条路由：读 5 + 写 6 全 confirm）。用于货件列表/详情/SKU 汇总/FBA 箱规/审计、创建货件、改货件信息、更新商品明细、改状态、重算成本、删除。Use when the user asks for 货件 / shipments / 货件查询 / 创建货件 / 货件状态 / 箱规 / FBA, 或任何需要从 dash-api.believeboy.com 读取或维护货件数据的任务。
---

# BelieveBoy Agent API · 货件（shipments）

跨项目货件查询与维护方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（11 条：读 5 + 写 6，business_scope "shipments"）

路径前缀：`/api/v1/agent/projects/{project_id}/shipments`

### 读路由（不落审计、绕过读缓存直查 DB）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/shipments` | 货件列表（多条件过滤 + 分页） |
| R2 | GET | `/shipments/{shipment_no}` | 单货件详情 |
| R3 | GET | `/shipments/{shipment_no}/sku-summary` | 货件内 SKU 汇总 |
| R4 | GET | `/shipments/{shipment_no}/fba-box-detail` | FBA 箱规明细 |
| R5 | GET | `/shipments/{shipment_no}/audit?limit=` | 操作审计轨迹（limit 默认 50，≤200） |

**R1 列表过滤参数**：`country` / `shipment_status` / `shipping_method` / `shipment_no`（子串）/ `created_date_from` / `created_date_to` / `etd_from` / `etd_to` / `eta_from` / `eta_to`（YYYY-MM-DD）+ `page`（默认1）/ `page_size`（默认20，≤100）。

```bash
curl -s "$BASE/projects/$PROJECT_ID/shipments?country=US&shipment_status=SHIPPED&page_size=20" "${AUTH[@]}"
```

### 写路由（**全部走 confirm 两步确认**，审计归因 agent_id + idempotency_key，operator=NULL）

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| W1 | POST | `/shipments` | 新建货件 |
| W2 | PUT | `/shipments/{shipment_no}/items` | 更新货件商品明细 |
| W3 | PATCH | `/shipments/{shipment_no}` | 改货件信息（如状态字段） |
| W4 | POST | `/shipments/{shipment_no}/status` | 改货件状态 |
| W5 | POST | `/shipments/{shipment_no}/recalculate-costs` | 重算货件成本（影响财务） |
| W6 | DELETE | `/shipments/{shipment_no}` | 删除货件 |

**confirm 流（所有写路由强制）**：

```bash
IDEMPOTENCY_KEY=$(uuidgen)
# 第一步（预览）：返回 confirm_token，不落库
curl -X POST "$BASE/projects/$PROJECT_ID/shipments" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "Content-Type: application/json" \
  -d '{"source":"agent_user_supplied", ...}'
# 第二步：向用户确认后，同一 URL + 同一 Idempotency-Key 重放 + X-Confirm-Token
curl -X POST "$BASE/projects/$PROJECT_ID/shipments" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Confirm-Token: <confirm_token>" \
  -H "Content-Type: application/json" -d '{"source":"agent_user_supplied", ...}'
```

写请求体必须与第一步完全一致；`source` 溯源枚举（同 sku-info 约定，禁 manual）。

## 3. 注意事项

- 读路由不落审计、绕过 Redis 读缓存直查 DB；写路由全 confirm + 写限流（30 次/分）
- 删除/重算成本涉及不可逆/费用变更——确认流是强制安全门，务必给用户看预览再重放
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；所有路由挂 `require_project_scope` + `business_scope("shipments")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/shipments.py`）
