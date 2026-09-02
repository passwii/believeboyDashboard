---
name: believeboy-platform-inspection
description: 调用 BelieveBoy Agent API 写侧维护平台巡检数据（platform_inspection 域，business_scope platform_inspection，路径带 project_id，5 条路由 R0+W1-W4）。用于巡检表单填报（W1 建档/更新草稿）、上传截图（W3）、提交巡检报告（W2，不可逆需确认）、删除截图（W4，不可逆需确认）。Use when the user asks for 平台巡检 / 填报巡检 / 提交巡检 / 上传巡检截图 / 店铺体检表单填写, 或任何需要向 dash-api.believeboy.com 写入巡检数据（与 account-health 读侧搭配使用）的任务。
---

# BelieveBoy Agent API · 平台巡检写侧（platform-inspection）

跨项目平台巡检（周粒度，每周期×店铺一条：账户健康评级 + 客服/配送绩效 + 政策合规分类计数）的**写侧**方法——巡检报告的填写 / 更新 / 提交 + 截图上传 / 删除。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

项目名以系统为准（共 13 个），未命中先向派发方确认，不猜。

## 2. 域概述与前置条件

- **本域 = 巡检数据写侧**，命名空间 `/api/v1/agent/platform-inspection/*`；数据底座复用 `inspection_periods` / `inspection_reports` / `inspection_screenshots`（零新增表/迁移），与读侧 account-health 同一套。
- **前置条件（缺一不可）**：
  1. Agent key 的 `business_scope` **包含 `platform_inspection`**（否则 403 `AGENT_BUSINESS_OUT_OF_SCOPE`）；
  2. Agent key 对目标项目有 `project_scope`（W1/W2/W3 路径带 `{project_id}` → 直接 403 `AGENT_PROJECT_OUT_OF_SCOPE`；W4 在服务端按截图归属项目校验）。
- **读写分离**：读巡检数据走 `believeboy-account-health` 域（周期/当前/概览/单店报告/历史），本域只写。当前周期 ID 也先经 account-health R2 `/account-health/periods/current` 拿。
- 截图响应**不含 presigned URL**（安全口径：R2 私桶临时凭证不外泄），只给 id + 元数据。
- 限流：R0 读桶 300 次/分；W1–W4 写桶 120 次/分（按 X-Agent-Id 计）。

## 3. 端点目录（R0 + W1–W4）

| # | 方法 | 路径 | 用途 | confirm |
|---|---|---|---|---|
| R0 | GET | `/platform-inspection/template` | 巡检表单模板（字段+类型+枚举+阈值） | 否（读） |
| W1 | PUT | `/platform-inspection/periods/{period_id}/projects/{project_id}` | 填写 / 更新报告（upsert 草稿，幂等） | 否 |
| W2 | POST | `/platform-inspection/periods/{period_id}/projects/{project_id}/submit` | 提交报告（draft/overdue → submitted，不可逆） | ⚠️ 是 |
| W3 | POST | `/platform-inspection/periods/{period_id}/projects/{project_id}/screenshots` | 上传截图（multipart，压缩+缩略图） | 否 |
| W4 | DELETE | `/platform-inspection/screenshots/{screenshot_id}` | 删除截图（R2 对象 + DB 行，不可逆） | ⚠️ 是 |

## 4. 端点调用说明

### 4.1 R0 GET /template（模板，写输入 schema 的唯一事实源）

返回写侧字段全集（类型 / 枚举 / 阈值），W1 请求体以此为 schema。模板按类目分组：`health_fields`（1，账户健康评级 select）、`service_performance_fields`（3，客服绩效）、`shipping_performance_fields`（4，配送绩效）、`compliance_fields`（10，合规计数）。注意 W1 的 `health_data` 块是**合并的 8 key**（rating + 客服 3 + 配送 4），与模板分组不同源形态、同字段。

```bash
curl -s "$BASE/platform-inspection/template" "${AUTH[@]}"
```

### 4.2 W1 PUT …/projects/{project_id}（填写 / 更新草稿）

- **upsert 语义**：`(period_id, project_id)` 无草稿 → 新建；有 → 覆盖更新（幂等，重复 PUT 不新建）。
- **显式字段合并（防默认值陷阱）**：只透传请求里**显式提供的 key**——`health_data` / `compliance_data` 未提供的子键保持当前值（不置 null 覆盖）；`status_summary` 显式提供才更新；缺失整块 → 保持现状。
- 请求体（`health_data` / `compliance_data` / `status_summary` 均可选，至少传一块）：
```json
{
  "health_data": { "account_health_rating": "Good", "negative_feedback": 2, "late_shipment_rate": 1.5 },
  "compliance_data": { "ip_infringement": 0, "listing_policy_violations": 1 },
  "status_summary": "本周账户状况良好，无异常"
}
```
- `account_health_rating` 枚举 ∈ `Healthy / Good / At Risk / Critical`（非法值 → 400 `VALIDATION_FAILED`）；阈值：warn 1 / crit 3（负反馈、A2Z、chargeback、合规计数），late_shipment_rate warn 2.0 / crit 4.0，valid_tracking_rate / on_time_delivery_rate warn 97.0 / crit 95.0 below。
- 周期不存在 → 404 `RESOURCE_NOT_FOUND`；项目不在凭据范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`。
- **不提供 `screenshot_ids`**（截图一律经 W3 上传挂靠 report）。

### 4.3 W2 POST …/submit（提交报告，confirm 两步）

- 提交前先 W1 建档（无草稿 → 404 `RESOURCE_NOT_FOUND`）。
- **不可逆**：确认后 `status=submitted` + `submitted_by=<agent_id>` + `submitted_at`，**无回退路径**（无 unsubmit）。
- 响应透出 `warnings`（阈值告警列表），Agent 应向用户汇报异常指标。

### 4.4 W3 POST …/screenshots（上传截图，multipart）

- `multipart/form-data`，字段 `file`（图片）；类型 `image/jpeg|png|webp|gif`、大小 ≤10MB（超限 → 400 `VALIDATION_FAILED`）。
- **前置要求**：该 (period, project) 必须先有草稿报告（先 W1 建档再传图，无草稿 → 404），对齐前端「先保存再传图」流程。
- 响应不含 presigned URL，只给 `screenshot_id` + `filename` / `content_type` / `file_size` / `caption` / `sort_order` / `created_at`。

### 4.5 W4 DELETE /screenshots/{screenshot_id}（删除截图，confirm 两步）

- **不可逆**：R2 原图 + 缩略图 + DB 行一并删除，无恢复路径。
- 项目范围在服务端按截图归属校验（不在凭据范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`）；截图不存在 → 404 `RESOURCE_NOT_FOUND`。

## 5. confirm 两步流程（仅 W2 / W4 必须）

- **第一步（预览）**：直接调目标接口（**不带** `X-Confirm-Token`）→ 返回 HTTP 200 `requires_confirmation=true` + `preview`（影响摘要）+ `confirm_token`（TTL 5 分钟）。**此步不落库**。
- **用户确认后（第二步）**：同一 URL + **同一 `Idempotency-Key`** + **`X-Confirm-Token: <confirm_token>`** + **完全相同的请求体** 重放 → 才真正执行。
- 请求体不一致 / Key 不同 / token 过期 → 400 `CONFIRM_TOKEN_INVALID` 或 409 `CONFIRM_TOKEN_EXPIRED`（重新走第一步拿新 token）。
- 交互纪律：**把 preview 内容复述给用户，明确声明不可逆后果，经用户确认后再重放**；不得自作主张跳过确认。

```bash
# W2 示例（两步）
IDEMPOTENCY_KEY=$(uuidgen)
# 第一步（预览，不落库）
curl -s -X POST "$BASE/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/submit" \
  "${AUTH[@]}" -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "Content-Type: application/json" -d '{}'
# → {"ok":false,"requires_confirmation":true,"confirm_token":"...","preview":{...},"expires_in_sec":300,...}
# 第二步（用户确认后重放，body 不变 + X-Confirm-Token）
curl -s -X POST "$BASE/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/submit" \
  "${AUTH[@]}" -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Confirm-Token: <confirm_token>" \
  -H "Content-Type: application/json" -d '{}'
```

## 6. 调用顺序建议

- **标准流程：先 W1 建档 → W3 传图 → W2 提交**（W3 需要草稿报告存在；W2 提交后不可逆，确认无误再交）。
- W4 可随时删除（无需先提交），但属删除性操作必须 confirm。
- **读当前周期**：先走 account-health `GET /account-health/periods/current` 拿 `period_id`，再填本域写侧。
- 草稿阶段可反复 W1 覆盖（不 confirm）；一旦提交则无法修改，需新周期重填。

## 7. 错误码速查表（复用码，无 INSPECTION_* 专属码）

| HTTP | 错误码 | 场景 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 请求体非法 JSON / `account_health_rating` 非枚举值 / 数值超限 / W3 文件类型或大小超限 / 缺少 file 字段 / Idempotency-Key 为空或 >64 字符 |
| 400 | `CONFIRM_TOKEN_INVALID` | confirm 重放请求体与第一步不一致 / token 与 agent 或 Idempotency-Key 不匹配 / token 不存在 |
| 403 | `AGENT_BUSINESS_OUT_OF_SCOPE` | key 的 `business_scope` 不含 `platform_inspection` |
| 403 | `AGENT_PROJECT_OUT_OF_SCOPE` | 目标项目不在 key 的 `project_scope`（W1/W2/W3 路径直取；W4 按截图归属项目校验） |
| 404 | `RESOURCE_NOT_FOUND` | 周期 / 草稿报告（W2 提交、W3 传图）/ 截图（W4）不存在 |
| 409 | `CONFIRM_TOKEN_EXPIRED` | confirm token 超过 5 分钟 TTL（重新走第一步） |
| 429 | — | 写桶 120 次/分 / 读桶 300 次/分 超限 |

> 未鉴权 → 401 壳；业务错误统一 agent 壳；限流响应带 `X-RateLimit-*` 头。**5xx**：一次性报告给报告 owner（Yawei），不要盲目重试。

## 8. 与 account-health 搭配使用

| 需求 | 走哪个域 |
|---|---|
| 周期列表 / 当前周期 / 概览 / 单店报告 / 历史 | **account-health（读）** |
| 填写 / 更新草稿、上传截图、提交报告、删除截图 | **platform-inspection（写，本域）** |

- 同属巡检数据底座，**读用 account-health、写用本域**，不要用本域端点读数据，也不要反向用 account-health 写。
- 读侧只给 `screenshot_count`、不暴露截图内容；本域写侧只给 id + 元数据、不暴露 presigned URL——两侧均不能直接在对话里展示截图原图，如需查看请引导用户去前端「平台巡检」页面。

## 9. 示例

```bash
# R0 拉模板
curl -s "$BASE/platform-inspection/template" "${AUTH[@]}"
# → {"ok":true,"data":{"health_fields":[...],"service_performance_fields":[...],
#    "shipping_performance_fields":[...],"compliance_fields":[...]}}

# W1 建档 / 更新草稿（幂等，可反复 PUT）
curl -s -X PUT "$BASE/platform-inspection/periods/{period_id}/projects/$PROJECT_ID" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"health_data":{"account_health_rating":"Good","negative_feedback":2},"compliance_data":{"ip_infringement":0}}'
# → {"ok":true,"data":{"report_id":123,"period_id":9,"project_id":3,"status":"draft",
#    "health_data":{...},"compliance_data":{...},"compliance_total":0,"status_summary":null,
#    "submitted_by":null,"submitted_at":null,"screenshot_count":0,"created_at":"...","updated_at":"..."},
#    "idempotency_key":"..."}

# W3 上传截图（multipart；先有草稿报告）
curl -s -X POST "$BASE/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/screenshots" \
  "${AUTH[@]}" -F "file=@/path/to/screenshot.png"
# → {"ok":true,"data":{"screenshot_id":5,"filename":"screenshot.png","content_type":"image/png",
#    "file_size":102400,"caption":null,"sort_order":1,"created_at":"..."}}

# W4 删除截图（confirm 两步，见 §5）
# 第一步预览 → 用户确认 → 带 X-Confirm-Token 重放
curl -s -X DELETE "$BASE/platform-inspection/screenshots/5" "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)"
curl -s -X DELETE "$BASE/platform-inspection/screenshots/5" "${AUTH[@]}" \
  -H "Idempotency-Key: <同一 Key>" -H "X-Confirm-Token: <confirm_token>"
# → {"ok":true,"data":{"deleted":true,"screenshot_id":5}}
```

- 完整 spec：`docs/superpowers/specs/2026-09-02-agent-platform-inspection-api.md`（模块 `backend/app/api/v1/endpoints/agent/platform_inspection.py`）
