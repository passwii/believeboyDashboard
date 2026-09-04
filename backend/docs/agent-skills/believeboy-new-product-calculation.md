---
name: believeboy-new-product-calculation
description: 调用 BelieveBoy Agent API 获取跨项目新品测算数据（new_product_calculations 域，business_scope new_product_calculations，5 条路由：读 3 + 写 1 + 试算 1）。用于新品正/倒测算、成本倒算、自发货测算的快照列表/详情/审计、写入与试算。Use when the user asks for 新品测算 / 新品计算 / profit calc / cost reverse / fbm calc, 或任何需要从 dash-api.believeboy.com 读取或写入新品测算数据的任务。
---

# BelieveBoy Agent API · 新品测算（new-product-calculation）

跨项目新品测算数据读取与写入方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点目录（5 条，business_scope "new_product_calculations"）

路径前缀：`/api/v1/agent/projects/{project_id}/new-product-calculations`

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/new-product-calculations` | 快照列表（calculation_type / country 过滤 + 分页，updated_at 倒序） |
| R2 | GET | `/new-product-calculations/skus/{sku}` | SKU 详情：当前行（calculation_type 缺省 profit_calc）；不存在 → 404 壳 |
| R3 | GET | `/new-product-calculations/skus/{sku}/audit` | SKU 审计：按该 SKU 全部快照行 id 聚合操作轨迹 |
| W1 | POST | `/new-product-calculations` | 快照写：**confirm 两步**后按 (project_id, sku, calculation_type) upsert + 审计归因 |
| C1 | POST | `/new-product-calculations/compute` | 试算：包装 4 引擎纯计算（不落库、不落审计），返回 `{calculation, snapshot}` 双字段 |

**calculation_type 枚举**（BLF-453/454/455/456 定稿）：`profit_calc`（正测算）/ `profit_reverse`（倒测算）/ `cost_reverse`（成本倒算）/ `fbm_calc`（自发货）。

```bash
# 列表（筛选正测算 + 国家）
curl -s "$BASE/projects/$PROJECT_ID/new-product-calculations?calculation_type=profit_calc&country=US&page_size=20" "${AUTH[@]}"

# 单 SKU 详情
curl -s "$BASE/projects/$PROJECT_ID/new-product-calculations/skus/{sku}?calculation_type=profit_calc" "${AUTH[@]}"

# 试算（不落库）
curl -s -X POST "$BASE/projects/$PROJECT_ID/new-product-calculations/compute" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{...输入参数...}'
```

## 3. 注意事项

- 读路由不落审计；W1 写走 confirm 两步 + 写限流；C1 试算不落库不落审计
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_project_scope` + `business_scope("new_product_calculations")`
- 完整 spec：`docs/superpowers/specs/2026-08-07-*` 新品测算设计（模块 `backend/app/api/v1/endpoints/agent/new_product_calculations.py`）
