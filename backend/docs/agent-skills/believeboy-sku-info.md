---
name: believeboy-sku-info
description: 调用 BelieveBoy Agent API 提取/维护跨项目 SKU 主数据（sku-info 域）。用于 SKU 列表查询（R1）、单 SKU 详情（R2）、审计轨迹（R3）、新建/更新 SKU（W1 upsert）、改成本规格（W2 PATCH）、上/下架（W3）。Use when the user asks for SKU 主数据 / 商品信息 / FNSKU / ASIN / 工厂信息 / 成本修改 / 上下架，或任何需要从 dash-api.believeboy.com 读取或维护 SKU 数据的任务。
---

# BelieveBoy Agent API · SKU 主数据（sku-info）

跨项目 SKU 主数据读取与维护的规范调用方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入：AGENT_KEY / AGENT_ID / API_BASE），禁止把 Key 明文写进本 skill、回复或任何文档。

## 0. 凭据来源与鉴权（每次请求缺一不可）

> **workspace env 变量名约定（统一）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认）。各 agent 的 custom_env 按此三件套配置，skill 内一律引用这三个名字，禁止硬编码/明文 Key。

```bash
KEY="${AGENT_KEY}"                  # 明文 Key，agent custom_env 注入
AGENT_ID="${AGENT_ID}"              # X-Agent-Id 业务主键，如 operator-manager-Damon
BASE="${API_BASE:-https://dash-api.believeboy.com/api/v1/agent}"
AUTH=(-H "Authorization: Bearer $KEY" -H "X-Agent-Id: $AGENT_ID")
```

- 若 env 未注入（旧会话进程），向派发方/owner 索取凭据；**禁止**从历史消息或 memory 里复制 Key 到文档。
- 存活探针：`curl -s "$BASE/health" "${AUTH[@]}"` → `{"ok":true,"data":{"agent_id":...}}`

## 1. 项目名 → ID 解析（派发只给项目名，先查 ID）

```bash
curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}"
# → {"ok":true,"data":[{"project_id":1,"project_name":"<项目名>"}]}
PROJECT_ID=$(curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}" | jq -r '.data[0].project_id')
```

项目名以系统为准（共 13 个：铨富/博智1店/博智2店/骏成/华洋泛航/弥森/卡斯摩/创酷/吕沃/瑞迪特/犀牛/博朗姆/玥涵），未命中先向派发方确认，不猜。

## 2. 端点目录

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/projects/{id}/sku-info` | SKU 列表（分页/筛选/搜索） |
| R2 | GET | `/projects/{id}/sku-info/{sku_record_id}` | 单 SKU 详情（工厂信息/图片/市场链接） |
| R3 | GET | `/projects/{id}/sku-info/{sku_record_id}/audit?limit=` | 审计轨迹（含人工前端操作 operator 列） |
| W1 | POST | `/projects/{id}/sku-info` | 新建/更新 SKU（upsert，两步确认） |
| W2 | PATCH | `/projects/{id}/sku-info/{sku_record_id}` | 更新规格/成本（两步确认） |
| W3 | POST | `/projects/{id}/sku-info/{sku_record_id}/status` | 上/下架（两步确认） |

## 3. 读操作（R1/R2/R3）

```bash
# R1 列表：country(2字母)可选；is_active 默认 true（只返回上架），查下架需显式 &is_active=false
# sku/asin 可选 ilike 模糊搜索；page 默认 1、page_size 默认 200（≤500）、include_total 可选
curl -s "$BASE/projects/$PROJECT_ID/sku-info?country=US&page_size=20&include_total=true" "${AUTH[@]}"
# → { items, page, page_size, total, has_next }

# R2 详情：返回全字段（sku_factory_info / fnsku_label_r2_url / product_image_r2_url /
# product_image_thumbnail_r2_url / marketplace_url / created_at / updated_at）；
# 不暴露内部 *_r2_key 与 source_file；记录不存在或跨项目 → 404
curl -s "$BASE/projects/$PROJECT_ID/sku-info/{sku_record_id}" "${AUTH[@]}"

# R3 审计：limit 默认 50（≤200）；返回 items(action/agent_id/operator/idempotency_key/result/before/after/error_message/created_at)
curl -s "$BASE/projects/$PROJECT_ID/sku-info/{sku_record_id}/audit?limit=50" "${AUTH[@]}"
```

## 4. 写操作（W1/W2/W3 · 强制两步确认）

写操作必须两步：**第一步（预览）返回 `confirm_token`，不落库** → 用户确认后**同一 URL + 同一 `Idempotency-Key`** 重放，另加 `X-Confirm-Token`。请求体必须与第一步完全一致。

```bash
# W1 upsert：sku / asin / country 必填（唯一键 (project_id, sku, asin, country) 命中则更新、否则插入）
# source 必填溯源枚举 ∈ agent_listing_pull / agent_user_supplied / external_api（禁 manual → 400）
# source_file 由服务端派生 agent:<agent_id>，不接受传值；currency 恒 CNY
# 可选：fnsku / product_name / fob_unit_cost / first_leg_cost_rmb / 包装尺寸/重量/箱规/units_per_carton / is_active / sort_order / sku_factory_info（数值均 ≥0）
IDEMPOTENCY_KEY=$(uuidgen)
# 第一步
curl -X POST "$BASE/projects/$PROJECT_ID/sku-info" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "Content-Type: application/json" \
  -d '{"sku":"X-001","asin":"ASIN-X-001","country":"US","source":"agent_user_supplied","product_name":"示例产品","fob_unit_cost":5.2}'
# → 返回 confirm_token；向用户展示预览并确认后，第二步重放（body 不变）：
curl -X POST "$BASE/projects/$PROJECT_ID/sku-info" "${AUTH[@]}" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Confirm-Token: <confirm_token>" \
  -H "Content-Type: application/json" \
  -d '{"sku":"X-001","asin":"ASIN-X-001","country":"US","source":"agent_user_supplied","product_name":"示例产品","fob_unit_cost":5.2}'
```

- **W2 PATCH**：只更新显式提供的字段（缺省字段不重置）；身份字段 sku/asin/country 禁改（→ VALIDATION_FAILED）；更新后唯一键冲突 → SKU_INFO_DUPLICATE 409。改成本/规格影响财务汇总/货件计费（预览 note 明示）。
- **W3 status**：`is_active=true` 上架 / `false` 下架（软切换非删除）；目标值与当前一致时幂等直接返回当前态。下架后 SKU 退出补货分析/定时报表/店铺测算默认消费（历史数据保留、可随时重新上架）。
- 场景选择：建新 SKU 用 W1、改成本/规格用 W2、上/下架用 W3；删除/批量/CSV 导入不对 Agent 开放（删除 → 用 W3 下架替代）。Idempotency-Key 可缺失；出现则非空且 ≤64 字符。

## 5. 注意事项

- 读路由不落审计；限流：读 300 次/分、写 30 次/分（按 X-Agent-Id 计）
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计（项目不存在先验 projects 解析）
- 明文 Key 只在创建时展示一次；吊销后立即失效，需换新卡
- 完整端点清单与 OpenAPI：believeboyDashboard 仓库 `backend/docs/external-api.md`
