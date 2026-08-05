# Agent API (`/api/v1/agent/*`)

面向 LLM Agent 的读写 API，替代原 `/api/v1/external/*`（后者过渡期保留，
见 `backend/docs/external-api.md` 顶部弃用说明）。设计文档：
[`docs/agent-api-design.md`](../../docs/agent-api-design.md)。

## 1. 鉴权（强制）

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <key_secret>`（管理页创建时的明文 Key，仅展示一次） |
| `X-Agent-Id` | ✅ | 与凭据绑定的 Agent ID 完全一致 |
| `Idempotency-Key` | 写时推荐 | ≤64 字符；缺失会在审计行打 `no_idempotency` 风险标记 |
| `X-Confirm-Token` | 危险写回放时 ✅ | 预览响应返回的 `confirm_token` |

不接受：`X-API-Key` 头、`?api_key=` 查询参数、`?skip_auth=true`、master key。
存量 external key（未绑定 agent_id）调本命名空间一律 401 `agent_id_mismatch`。

凭据管理：前端"系统 → Agent 凭据"页（`/dashboard/system/agent-management`），
或 admin 调 `POST/GET /api/v1/internal/api-keys`。

## 2. 端点

    GET /api/v1/agent/health    存活探针

### 货件域（P2）

    GET    /api/v1/agent/projects/{project_id}/shipments
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/sku-summary
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/fba-box-detail
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/audit
    POST   /api/v1/agent/projects/{project_id}/shipments                      （confirm）
    PATCH  /api/v1/agent/projects/{project_id}/shipments/{shipment_no}        （confirm）
    PUT    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/items  （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/status （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/recalculate-costs （confirm）

写接口（confirm）两步：第一次调用返回 HTTP 200 + `requires_confirmation:true` +
`confirm_token`（300s 有效，与请求体 SHA-256 绑定）；向用户复述 preview 摘要，
确认后**用同一 Idempotency-Key + X-Confirm-Token + 完全相同的请求体**重放。

货件字段约定：`shipment_status` ∈ {draft, in_transit, completed}；
`shipping_method` ∈ {sea, air, express, truck, rail, other}（英文 token）。

## 3. 响应壳

成功：`{ "ok": true, "data": ..., "idempotency_key": "..." }`

失败：`{ "ok": false, "error": { "code", "reason"?, "human_message", "agent_hint", "details"? } }`

错误码（稳定，Agent 可依赖）：`AGENT_AUTH_FAILED`(401) /
`AGENT_RATE_LIMIT_EXCEEDED`(429, 附 Retry-After) / `VALIDATION_FAILED`(400) /
`RESOURCE_NOT_FOUND`(404) / `CONFIRM_TOKEN_INVALID`(400) /
`CONFIRM_TOKEN_EXPIRED`(409) / `IDEMPOTENCY_KEY_CONFLICT`(409) /
`SHIPMENT_DUPLICATE_NO`(409) / `SHIPMENT_ITEMS_INVALID_SKU`(400) /
`SHIPMENT_STATUS_INVALID`(400) / `INTERNAL_ERROR`(500)。

## 4. curl 示例

    curl -i http://<host>/api/v1/agent/health \
      -H "Authorization: Bearer bbx_xxx" \
      -H "X-Agent-Id: shipment-assistant-prod"

## 5. 限流

读 300 req/min、写 30 req/min（按 agent_id 计，内存计数、按 worker 独立）。
超限返回 429 壳 + `Retry-After`。
