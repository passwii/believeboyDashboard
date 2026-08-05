# Agent 读写 API 实施规格

> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（设计稿 v0.4 — 术语同步版）
> **状态**：实施规格 v0.4（external → agent 改名同步），等待设计稿评审通过后进入 writing-plans → executing-plans。
> **范围**：把设计稿拆成可执行的 **P0 基础设施** + **P2 货件域**端到端用例。**P1 路径迁移、P3 其他域、P4 AI Chat 工具调用清单不在本 spec**，另起 spec。

---

## 1. 目标与边界

### 1.1 本 spec 交付内容

1. **P0 基础设施**：external → agent **改名一批**（表/索引/模型/key service/审计中间件/celery 任务/2 个审计配置项，见设计稿 §11.2）+ `/api/v1/agent/*` 命名空间 + 鉴权依赖（改名并扩展 BEL-377 `external_api_keys` → `agent_api_keys`）+ 审计字段扩展 + slowapi 限流 + 响应壳 + 错误码注册表 + confirm 装饰器 + 前端"Agent 凭据管理"页（生成/吊销）。
2. **P2 货件域写通道**：在 `/api/v1/agent/projects/{id}/shipments/*` 下开放 §5 列出的全部路由，复用 `app.services.shipment.*`，所有写接口走 confirm 流。

### 1.2 本 spec **不**交付

- 路径迁移（P1）：单独 spec。
- 定价/店铺/库存域（P3）：单独 spec。
- AI Chat 工具调用清单注册（P4）：单独 spec。
- scope / 权限细分：明确不做（`agent_api_keys.scope` 列已预留）。

---

## 2. 文件改动清单

### 2.1 后端

| 类型 | 路径 | 用途 |
|---|---|---|
| 新增 | `backend/alembic/versions/YYYYMMDD_<NNN>_rename_agent_api_keys.py` | `external_api_keys` RENAME → `agent_api_keys`（含 `idx_eak_*` → `idx_aak_*`）+ 加 `agent_id` / `project_scope` 列 + 索引 |
| 新增 | `backend/alembic/versions/YYYYMMDD_<NNN+1>_rename_agent_api_audit_log.py` | `external_api_audit_log` RENAME → `agent_api_audit_log`（含其索引） |
| 新增 | `backend/alembic/versions/YYYYMMDD_<NNN+2>_audit_logs_agent_fields.py` | `operation_audit_logs` 加 `agent_id` / `idempotency_key` 列 + 索引 |
| 改名 | `backend/app/models/external_api_key.py` → `agent_api_key.py` | 类 `ExternalApiKey` → `AgentApiKey`；`__tablename__` → `agent_api_keys`；索引名同步；加 `agent_id: Mapped[str \| None]`、`project_scope: Mapped[str]` 列；`models/__init__.py` 导出同步 |
| 改名 | `backend/app/models/external_api_audit_log.py` → `agent_api_audit_log.py` | 类 `ExternalApiAuditLog` → `AgentApiAuditLog`；`__tablename__` → `agent_api_audit_log`；`models/__init__.py` 导出同步 |
| 挪动 | `backend/app/services/external/api_key_service.py` → `backend/app/services/agent/key_service.py` | 新包 `app/services/agent/`；**函数名不动**（`generate_key`/`create_api_key`/`resolve_key`/`revoke_api_key`）；`create_api_key` 支持 `agent_id` 参数；新增 `list_agent_keys` 过滤；旧位置不留 re-export 壳（引用方全部改 import） |
| 改名 | `backend/app/middleware/external_audit.py` → `agent_api_audit.py` | 前缀列表同时覆盖 `/api/v1/external/*` 与 `/api/v1/agent/*`；`main.py` 挂载处同步 |
| 改名 | `backend/app/celery_tasks/external_audit_cleanup.py` → `agent_api_audit_cleanup.py` | `celery_app.py` beat 注册 / queue 路由 / task 路径 3 处同步（`:54/:91/:121`） |
| 改 | `backend/app/core/config.py` | `external_api_audit_enabled` / `external_api_audit_retention_days` → `agent_api_audit_enabled` / `agent_api_audit_retention_days`；新增 `agent_api_read_rate_limit`（默认 300）/ `agent_api_write_rate_limit`（默认 30）；4 个 `/external/*` 专用开关（`external_api_require_auth` 等）**不动** |
| 新增 | `backend/app/api/agent/__init__.py` | `/api/v1/agent/*` 命名空间 router 装配 |
| 新增 | `backend/app/api/agent/auth.py` | 鉴权依赖 `require_agent_credential`：Bearer → SHA-256 → 查 `agent_api_keys` → 比对 `X-Agent-Id` → 注入 `request.state.agent_id`；通过后更新 `last_used_at`（60s 节流） |
| 新增 | `backend/app/api/agent/rate_limit.py` | slowapi `Limiter(key_func=get_agent_id_or_ip)`（对齐 `app/api/external_security.py` 的内存存储模式） |
| 新增 | `backend/app/api/agent/response.py` | `AgentResponse` 统一响应壳 |
| 新增 | `backend/app/api/agent/errors.py` | `ErrorCode` 注册表（Enum） |
| 新增 | `backend/app/api/agent/confirm.py` | `@require_confirmation(action)` 装饰器 + Redis confirm_token 存储（`app/services/infra` 现有 Redis 客户端） |
| 新增 | `backend/app/api/v1/endpoints/agent/__init__.py` | agent 子路由汇总（结构仿 `endpoints/external/__init__.py`） |
| 新增 | `backend/app/api/v1/endpoints/agent/health.py` | `GET /api/v1/agent/health` 存活探针 |
| 新增 | `backend/app/api/v1/endpoints/agent/shipments.py` | 货件域全部 agent 路由（详见 §5） |
| 新增 | `backend/app/schemas/agent_shipment.py` | agent 货件路由的请求/响应 schema（agent 侧字段命名，映射到现有 service 入参） |
| 改 | `backend/app/models/operation_audit_log.py` | 加 `agent_id`、`idempotency_key` 列 |
| 改 | `backend/app/api/v1/endpoints/internal/api_keys.py` | 创建/列表接口透传 `agent_id`（仅 admin）；import 指向 `app/services/agent/key_service`；新审计行 `target_type` 用 `agent_api_key`（历史行 `external_api_key` 不回填） |
| 改 | `backend/app/api/external_security.py` | `api_key_service` import 指向新位置（`app/services/agent/key_service`）；逻辑不动 |
| 改 | `backend/app/services/audit_log_service.py` | `append_operation_audit_log` 加可选 kwargs `agent_id=None, idempotency_key=None` |
| 改 | `backend/app/api/v1/router.py` | `api_router.include_router(agent_router)`（与 `external_router` 并列，`:121` 附近） |
| 改 | `backend/app/api/v1/endpoints/external/__init__.py` | 给 `/external/*` 响应加 `Deprecation` / `Sunset` / `Link` 头 |

> **引用面排查**（实施时用 `codegraph impact` / grep 逐一确认，防止漏改）：`ExternalApiKey` / `ExternalApiAuditLog` / `api_key_service` / `external_audit` / `external_audit_cleanup` / `EXTERNAL_API_AUDIT` 的全部 import 与字符串引用。

### 2.2 前端

| 类型 | 路径 | 用途 |
|---|---|---|
| 新增 | `frontend/app/dashboard/system/agent-management/page.tsx` | "Agent 凭据管理"页：列表 + 生成 + 吊销（对齐 `system/` 下 account-management、operator-management 等既有页面结构） |
| 新增 | `frontend/lib/api/agent-key-admin.ts` | 调用 `/api/v1/internal/api-keys`（含 agent_id）的 fetch 封装 |
| 改 | `frontend/lib/sidebar-config.ts` | "系统"分组下加入口（与 backup-management、logs 同级） |
| 改 | `frontend/lib/dashboard-route-meta.ts` | 路由 meta 注册 |

### 2.3 文档

| 类型 | 路径 | 用途 |
|---|---|---|
| 新增 | `backend/docs/agent-api.md` | 用户面向的 Agent API 使用文档（鉴权头说明 + curl 示例 + 错误码表） |
| 改 | `backend/docs/external-api.md` | 顶部加弃用 banner → 指向 `docs/agent-api-design.md`；正文保留（描述遗留契约至 `/external/*` 退役） |
| 改 | `docs/deployment/external-api-network-isolation.md` | 顶部加说明：`/api/v1/agent/*` 沿用同一网关隔离策略 |
| 改 | `docs/external-api-ops-agent-roadmap.md` | 顶部加术语说明（文中"external API"此后按"Agent API · 读侧"理解）；文件名保留 |

---

## 3. 数据库迁移

> **命名规范**（`AGENTS.md`）：文件名 `YYYYMMDD_NNN_description.py`，rev-id 纯数字顺延；建前 `git fetch origin && git rebase origin/main && alembic heads` 确认单链。三个迁移**不要**合成一个（便于独立回滚），也**不要**裸跑 `alembic revision`。**所有 RENAME 迁移的 downgrade 必须包含反向 RENAME**。

### 3.1 `external_api_keys` 改名 + 加列

```python
op.rename_table("external_api_keys", "agent_api_keys")
op.execute("ALTER INDEX idx_eak_key_hash RENAME TO idx_aak_key_hash")
op.execute("ALTER INDEX idx_eak_revoked_expires RENAME TO idx_aak_revoked_expires")
op.add_column("agent_api_keys", sa.Column("agent_id", sa.String(128), nullable=True))
op.add_column("agent_api_keys", sa.Column("project_scope", sa.String(255), nullable=False, server_default="*"))
op.create_index("idx_aak_agent_id", "agent_api_keys", ["agent_id"])
```

- PG 的 `RENAME` 是目录级操作（毫秒级、不重写数据、不锁全表写阻塞之外的重活），RENAME 与加列放同一迁移保证原子。
- 存量行 `agent_id = NULL`（旧式只读 external key，行为不变）。

### 3.2 `external_api_audit_log` 改名

```python
op.rename_table("external_api_audit_log", "agent_api_audit_log")
# 该表现有索引同步 ALTER INDEX ... RENAME（实施时以模型定义里的实际索引名为准）
```

### 3.3 `operation_audit_logs` 加列

```python
op.add_column("operation_audit_logs", sa.Column("agent_id", sa.String(128), nullable=True))
op.add_column("operation_audit_logs", sa.Column("idempotency_key", sa.String(64), nullable=True))
op.create_index("idx_oal_agent_id", "operation_audit_logs", ["agent_id"])
```

**`Idempotency-Key` 头校验规则**：非空字符串，≤64 字符（超出 → 400 `VALIDATION_FAILED`）；不强制 UUID 格式，调用方可用自己的去重键。

---

## 4. P0 基础设施：端到端用例

### 4.1 用例 E1：管理员生成 Agent 凭据

**前置**：管理员已登录。

**请求**：
```bash
POST /api/v1/internal/api-keys
Content-Type: application/json

{ "label": "货件助理 (生产)", "agent_id": "shipment-assistant-prod" }
```

**期望**：
1. `api_key_service.create_api_key`：
   - `generate_key()` 产明文 secret + `key_prefix`（现有逻辑，如 `bbx_ab12cd34`）
   - `hash_key(secret)` = SHA-256 hex 写入 `key_hash`，**明文只在响应里返回一次**（现有行为）
   - `agent_id` 写入新列
2. 响应含 `plaintext_key`（仅此一次）与 `agent_id`
3. 列表 `GET /api/v1/internal/api-keys` 出现新行：`label / key_prefix / agent_id / 未吊销`
4. 审计行：`action=api_key.create, target_type=agent_api_key, operator=<管理员>`（人发起，走既有归因；历史行 `target_type=external_api_key` 不回填）

### 4.2 用例 E2：Agent 调用健康检查

**请求**：
```bash
curl -i http://api/api/v1/agent/health \
  -H "Authorization: Bearer <plaintext_key>" \
  -H "X-Agent-Id: shipment-assistant-prod"
```

**期望**：
- 200：`{ "ok": true, "data": { "agent_id": "shipment-assistant-prod", "server_time": "..." } }`
- 该 key 的 `last_used_at` 被更新
- 401 / reason=`token_invalid`：Authorization 缺失或 key 不存在
- 401 / reason=`agent_id_mismatch`：`X-Agent-Id` 与 key.agent_id 不一致
- 401 / reason=`token_revoked`：key 已吊销
- 401 / reason=`token_expired`：key 已过期

### 4.3 用例 E3：限流触发

**前置**：E1 凭据。读桶默认 300 req/min。

**操作**：1 秒内并发请求 `/api/v1/agent/health` 100 次。

**期望**：前若干次 200，超额 429：
```json
{
  "ok": false,
  "error": {
    "code": "AGENT_RATE_LIMIT_EXCEEDED",
    "human_message": "Agent 调用频率超限",
    "agent_hint": "请在 Retry-After 秒后重试"
  }
}
```
响应头：`Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`。

> 注：slowapi 内存存储，限额按 worker 独立计数（与现有 external limiter 同口径）。

### 4.4 用例 E4：审计字段（写路径才落库）

**P0 覆盖方式**（不依赖任何写路由桩）：
1. **service 层单测**：直接调 `append_operation_audit_log(..., agent_id="shipment-assistant-prod", idempotency_key="<uuid>")`，断言新列正确落库；缺 `Idempotency-Key` 时 `after_json` 含 `{"risk": "no_idempotency"}`
2. **路由层**：`GET /api/v1/agent/health` 前后断言 `operation_audit_logs` 行数不变（读不落审计，与 `append_operation_view_log` no-op 决策一致）
3. 路由级写审计断言在 P2 用例 S3 / S7 里做

**期望**（写调用产生的行）：
- `operator = NULL`（agent 发起）
- `agent_id = 'shipment-assistant-prod'`
- `idempotency_key = <请求头值>`
- `action / target_type / target_id` 按动作填

**验证 SQL**：
```sql
SELECT operator, agent_id, action, idempotency_key
FROM operation_audit_logs
WHERE agent_id = 'shipment-assistant-prod'
ORDER BY id DESC LIMIT 1;
```

### 4.5 用例 E5：吊销凭据

**请求**：`POST /api/v1/internal/api-keys/{id}/revoke`（现有端点）

**期望**：
1. `is_revoked = true`（现有软吊销逻辑）
2. 前端列表状态变 `revoked`
3. 同一凭据再调 `/api/v1/agent/health` → 401 / reason=`token_revoked`

### 4.6 用例 E6：错误响应壳

**操作**：`GET /api/v1/agent/projects/999999/shipments`（不存在的项目）。

**期望**：
```json
{
  "ok": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "human_message": "请求的资源不存在",
    "agent_hint": "请检查 project_id；可用 GET /api/v1/agent/projects 查询可见项目"
  }
}
```

---

## 5. P2 货件域：端到端用例

> 复用 `app.services.shipment.*` 既有 service（下表均为**代码里真实存在的函数名**）。Agent 路由层只做：鉴权 → 参数映射 → 调 service → 写审计 → 包响应壳。

### 5.1 路由清单（v0.3）

| Method | Path | 复用 service（真实函数） | confirm |
|---|---|---|---|
| GET | `/api/v1/agent/projects/{id}/shipments` | `schedule.list_shipment_schedules` | ❌ |
| GET | `/api/v1/agent/projects/{id}/shipments/{shipment_no}` | `schedule.get_shipment_schedule_detail` + `serialization` | ❌ |
| GET | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/sku-summary` | `summary.list_shipment_sku_summary` | ❌ |
| GET | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/fba-box-detail` | `schedule.list_shipment_fba_box_details` | ❌ |
| POST | `/api/v1/agent/projects/{id}/shipments` | `schedule.create_shipment_schedule` + `item.replace_shipment_schedule_items`（复合：建单 + 设明细） | ⚠️ |
| PATCH | `/api/v1/agent/projects/{id}/shipments/{shipment_no}` | `schedule.update_shipment_schedule`（**全量更新语义**，路由层先读后合并） | ⚠️ |
| PUT | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/items` | `item.replace_shipment_schedule_items`（**替换**语义，非追加） | ⚠️ |
| POST | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/status` | 读当前 schedule → 改 `shipment_status` → `schedule.update_shipment_schedule`（薄封装） | ⚠️ |
| POST | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/recalculate-costs` | `schedule.calculate_shipment_schedule_costs`（**会回写费用字段**，非纯计算） | ⚠️ |
| GET | `/api/v1/agent/projects/{id}/shipments/{shipment_no}/audit` | **新增** `audit_log_service.query_operation_audit_logs(target_type, target_id)` | ❌ |

**状态词表**（`validation.ALLOWED_SHIPMENT_STATUS`）：`draft` → `in_transit` → `completed`。**没有其他值**——agent 传其他值直接 `VALIDATION_FAILED`。

**关键事实**：
- `ShipmentScheduleCreate` 必填 `project_id` / `shipment_no` / `shipping_method` / `shipment_status`；日期字段是 `created_date` / `etd_date` / `eta_date` / `actual_inbound_date`；**Create schema 不含 items**——明细走 `replace_shipment_schedule_items`，所以 agent 的"创建货件"是端点层复合（一次 confirm 覆盖建单 + 明细两步）。
- `calculate_shipment_schedule_costs(db, schedule_id, *, logistics_unit_price)` 基于已导入明细计算体积重/计费重并**更新该 schedule 的物流费用**；明细为空或缺 SKU 会 400。因此它是**写操作**，必须 confirm，命名用 `recalculate-costs` 避免误导。
- `ShipmentScheduleUpdate` 是**全量** schema（所有字段必填或有默认），PATCH 端点需先读当前值再合并请求里的增量字段。**P0 并发语义 = last-write-wins**（读-改-写，无乐观锁）；confirm 流本身已把写频率压得很低，暂不加版本号。
- **审计映射**：所有货件写操作的审计行统一 `target_type="shipment_schedule"`、`target_id=<schedule.id>`（数字 id，非 shipment_no）。`GET .../audit` 端点先把 path 里的 `shipment_no` 解析成 schedule id 再查审计表。

### 5.2 用例 S1：列出货件（读，不落审计）

```bash
curl "http://api/api/v1/agent/projects/123/shipments?country=US&shipment_status=draft" \
  -H "Authorization: Bearer <key>" -H "X-Agent-Id: shipment-assistant-prod"
```

**期望**：200 `{ "ok": true, "data": <ShipmentScheduleListResponse 同构> }`；**不新增审计行**。

### 5.3 用例 S2：重算费用（写 + confirm）

**前置**：`SH-2026-0007` 已存在且已导入明细。

第一次调用（预览）：
```bash
curl -X POST http://api/api/v1/agent/projects/123/shipments/SH-2026-0007/recalculate-costs \
  -H "Authorization: Bearer <key>" -H "X-Agent-Id: shipment-assistant-prod" \
  -H "Idempotency-Key: <uuid>" -H "Content-Type: application/json" \
  -d '{"logistics_unit_price": 13.5}'
```

**期望**（不落库）：
```json
{
  "ok": false,
  "requires_confirmation": true,
  "confirm_token": "cf_xxx",
  "preview": {
    "action": "shipment.recalculate_costs",
    "shipment_no": "SH-2026-0007",
    "logistics_unit_price": 13.5,
    "note": "将按 SKU 尺寸/重量重算体积重与计费重，并回写该货件的物流费用"
  },
  "expires_in_sec": 300,
  "human_message": "该操作将重算并覆盖货件费用字段，请向用户确认后继续",
  "agent_hint": "复述摘要给用户；确认后带同一 Idempotency-Key + X-Confirm-Token 重放"
}
```
第二次带 `X-Confirm-Token` 重放 → 200，`calculate_shipment_schedule_costs` 执行，费用字段被更新，审计行 `action=shipment.recalculate_costs`。

明细缺失时（confirm 前的业务校验）→ 400 `VALIDATION_FAILED`（沿用 service 的"请先导入 SKU 明细"语义）或 `SHIPMENT_ITEMS_INVALID_SKU`。

### 5.4 用例 S3：创建货件（复合写 + confirm）

第一次调用（预览）：
```bash
curl -X POST http://api/api/v1/agent/projects/123/shipments \
  -H "Authorization: Bearer <key>" -H "X-Agent-Id: shipment-assistant-prod" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{
    "shipment_no": "SH-2026-0008",
    "country": "US",
    "shipping_method": "海运",
    "shipment_status": "draft",
    "etd_date": "2026-08-20",
    "eta_date": "2026-09-15",
    "logistics_unit_price": 13.5,
    "items": [{"sku": "X-001", "quantity": 100}, {"sku": "X-002", "quantity": 50}]
  }'
```

**期望**（第一次，不落库）：**HTTP 200** + `requires_confirmation: true` + preview（shipment_no、items_count、total_quantity、状态=draft）。confirm 预览是协议内的正常一步，不是错误（设计稿 §3.1）。

第二次带 `X-Confirm-Token: cf_xxx` 重放：
- 端点层复合执行：`create_shipment_schedule`（不含 items）→ `replace_shipment_schedule_items`，**同一事务**
- 200：`{ "ok": true, "data": <新 schedule 详情>, "idempotency_key": "550e..." }`
- 审计行：`agent_id=shipment-assistant-prod, action=shipment.create, idempotency_key=550e...`
- confirm_token 用后即删

### 5.5 用例 S4：confirm token 过期

S3 第一次调用后等待 > 300s，再用同一 `Idempotency-Key` + `X-Confirm-Token` 重放。

**期望**：HTTP 409（状态映射固定，见设计稿 §5.3）：
```json
{
  "ok": false,
  "error": {
    "code": "CONFIRM_TOKEN_EXPIRED",
    "human_message": "确认凭证已过期",
    "agent_hint": "请重新发起预览请求，向用户再次确认后再调用"
  }
}
```

**相关分支**（同一路由一并覆盖）：
- 重放时**修改了请求体** → HTTP 400 `CONFIRM_TOKEN_INVALID`（confirm_token 与预览时的 body SHA-256 绑定）
- 同一 `Idempotency-Key` 配不同请求体 → HTTP 409 `IDEMPOTENCY_KEY_CONFLICT`

### 5.6 用例 S5：推进状态（写 + confirm）

**前置**：`SH-2026-0008` 处于 `draft`。

```bash
curl -X POST http://api/api/v1/agent/projects/123/shipments/SH-2026-0008/status \
  -H "Authorization: Bearer <key>" -H "X-Agent-Id: shipment-assistant-prod" \
  -H "Idempotency-Key: <new_uuid>" -H "Content-Type: application/json" \
  -d '{"to_status": "in_transit"}'
```

**期望**：
- 第一次：`requires_confirmation: true`，preview `{ "from_status": "draft", "to_status": "in_transit" }`
- 第二次重放：执行"读当前 → 合并 shipment_status → `update_shipment_schedule`"，状态变 `in_transit`
- 审计行 `action=shipment.status.transition`，`before_json/after_json` 含状态变化
- 传非法状态（如 `"shipped"`）→ `VALIDATION_FAILED`，details 里给出合法词表 `draft / in_transit / completed`

### 5.7 用例 S6：业务校验失败（自纠友好）

S3 body 里放不存在的 SKU `"X-999"`。

**期望**：400：
```json
{
  "ok": false,
  "error": {
    "code": "SHIPMENT_ITEMS_INVALID_SKU",
    "human_message": "明细里有 1 个 SKU 在本项目不存在",
    "agent_hint": "先核对 SKU 主数据（sku-info 相关端点），修正后重试",
    "details": [{ "row": 2, "sku": "X-999", "reason": "not_found" }]
  }
}
```
业务校验**先于** confirm 流——不生成 confirm_token。

### 5.8 用例 S7：读货件审计

```bash
curl http://api/api/v1/agent/projects/123/shipments/SH-2026-0008/audit \
  -H "Authorization: Bearer <key>" -H "X-Agent-Id: shipment-assistant-prod"
```

**期望**：200，返回该货件的审计行（时间倒序），含 `agent_id`、`action`、`result`、`before_json/after_json`。需要新增 `audit_log_service.query_operation_audit_logs`（现有 service 只有 append 类函数，无查询函数）。

---

## 6. 前端"Agent 凭据管理"页

### 6.1 位置与布局

路径：`/dashboard/system/agent-management`（对齐 `system/` 分组既有页面：account-management、operator-management、backup-management、logs）。

> 已核实：前端目前**没有**任何 external key 管理 UI（纯 API 管理）。本页是凭据管理的**第一个 UI**，同时覆盖存量 external key 的查看（列表展示全部 key，agent 凭据多一列 Agent ID）。

```
┌──────────────────────────────────────────────────────────┐
│ Agent 凭据管理                              [+ 创建凭据]   │
├──────────────────────────────────────────────────────────┤
│ 名称             │ Key 前缀      │ Agent ID       │ 状态  │
│ 货件助理 (生产)   │ bbx_ab12cd34 │ shipment-assis… │ active │
│ 数据拉取 (生产)   │ bbx_9f3e21aa │ data-pull-agent │ revoked│
└──────────────────────────────────────────────────────────┘
[创建成功弹窗]
  明文 Key：<plaintext_key>
  Agent ID：shipment-assistant-prod
  ⚠ 明文仅展示一次，请妥善保存（Authorization 用明文 Key，X-Agent-Id 用 Agent ID）
```

### 6.2 创建表单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| 名称（label） | ✅ | 人类可读 |
| Agent ID | ✅（agent 凭据必填） | 业务主键，全局稳定 |
| 过期时间 | ❌ | 留空 = 永不过期 |

### 6.3 操作

- 列表 + 创建 + 吊销（**P0 不做轮换、不做删除**——吊销即软删除，沿用现有 revoke 端点）
- 列表展示 `key_prefix`（不展示任何 secret）、`last_used_at`

---

## 7. 测试清单

### 7.1 后端

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_auth.py` | E2 全部 401 分支 |
| `backend/tests/api/agent/test_rate_limit.py` | E3 |
| `backend/tests/api/agent/test_response_shell.py` | E6 |
| `backend/tests/api/agent/test_shipments_read.py` | S1（含"不落审计"断言） |
| `backend/tests/api/agent/test_shipments_confirm.py` | S2 / S3 / S4 / S5 / S6 |
| `backend/tests/api/agent/test_shipments_audit.py` | S7 + E4 |
| `backend/tests/services/agent/test_key_service_agent.py` | E1 / E5（agent_id 扩展单测；随 service 挪到新包 `app/services/agent/`） |
| 改：`backend/tests/api/test_external_auth.py` 等既有 external 测试 | 更新 import（key service 新位置）与表名断言；场景本身保留 |

### 7.2 前端

| 文件 | 覆盖 |
|---|---|
| `frontend/tests/crawl/agent-management.spec.ts` | 页面渲染 + 创建弹窗（明文只展示一次）+ 吊销 |

### 7.3 运行顺序（`AGENTS.md` 约定）

```
cd backend && pytest -q tests/api/agent tests/services/agent tests/api/test_external_auth.py
cd frontend && pnpm lint && pnpm build && pnpm test
```

---

## 8. 部署与回滚

### 8.1 部署前检查（改名相关，必做）

1. **VPS env 检查**：`grep EXTERNAL_API <env 文件>`——若设置了 `EXTERNAL_API_AUDIT_ENABLED` / `EXTERNAL_API_AUDIT_RETENTION_DAYS`，同步改成 `AGENT_API_*`，否则新配置落回默认值（4 个 `/external/*` 专用开关不动）。
2. **确认 `external_api_require_auth` 在 VPS 的取值**：默认关 → RENAME 窗口期无影响；若已开启，窗口内 external 请求会短暂 401/500，需安排在低峰。
3. `codegraph impact` / grep 确认 `ExternalApiKey`、`api_key_service`、`external_audit`、`external_audit_cleanup` 无遗漏引用。

### 8.2 部署顺序

1. **先迁移**：`alembic upgrade head`（3.1/3.2 是 RENAME + 纯加法，3.3 纯加法，均不破坏数据）。RENAME 生效到旧进程重启之间有秒级窗口：
   - 凭据表：`external_api_require_auth` 默认关，旧代码不碰表 → 无影响
   - 访问审计表：中间件"永不破坏请求"（DB 操作吞错）→ 窗口内静默丢几行审计，可接受
2. **再后端**：agent 路由挂上；改名后的中间件/celery 任务随 `systemctl restart` 生效；`/external/*` 继续工作 + Deprecation 头。celery 换名注意：旧 worker 若残留旧名任务会不被消费——该任务每日一次且幂等，最坏漏一次清理、次日补上
3. **最后前端**：Agent 凭据管理页上线

### 8.3 回滚

- 先下前端 → 再下后端 → `alembic downgrade -3`（三个迁移独立可退；RENAME 迁移的 downgrade 已含反向 RENAME + 反向索引改名）
- 任何环节出问题：`/external/*` 与人用 UI 完全不受影响（零改动）

### 8.4 部署方式

遵循 `AGENTS.md` §Push / 部署规则：`git deploy`（命中 `backend/` 自动触发 VPS 部署 + `alembic upgrade head`）。

---

## 9. 不在本 spec 范围（防范围蔓延）

明确**不做**：

- ❌ Scope / 权限细分（P0 只校验身份；`agent_api_keys.scope` 列预留）
- ❌ 完整幂等响应缓存（只写审计留痕）
- ❌ `/api/v1/external/*` → `/api/v1/agent/*` 301 重定向（P1 spec）
- ❌ 定价/店铺/库存域（P3 spec）
- ❌ AI Chat 工具调用清单注册（P4 spec）
- ❌ Token refresh / 短 token
- ❌ 删除 / 隐藏货件对 Agent 开放（admin only）
- ❌ 新建 `agent_tokens` 表（改名 + 复用 `external_api_keys` → `agent_api_keys`）
- ❌ 自写 Redis 令牌桶限流（用 slowapi）

---

## 10. 评审清单（开工前请逐项打勾）

- [ ] 设计稿 [`docs/agent-api-design.md`](../../agent-api-design.md) v0.4 已 review（尤其 §4.1"改名 + 扩展 external_api_keys → agent_api_keys"决策、§5.3 状态码映射、§11 改名矩阵与部署窗口分析）
- [ ] §11.2 改名矩阵无异议（特别是**现在就改**与**保留旧名至退役**的划分）
- [ ] §3 三个迁移的 RENAME / 列名 / 索引无异议，downgrade 含反向 RENAME
- [ ] §5.1 路由清单（confirm 白名单、`recalculate-costs` 为写操作、items 为**替换**语义）无异议
- [ ] 状态词表只有 `draft / in_transit / completed`，确认 agent 不需要新状态值
- [ ] §6 前端页面落在 `system/agent-management` 无异议
- [ ] §9"不做的范围"无异议

---

## 修订记录

- **v0.4（2026-08-04）**：external → agent 术语同步（对齐设计稿 v0.4 §11）——
  1. §2.1 文件清单加改名/挪动条目：模型（2 个）、key service 挪入新包 `app/services/agent/`、审计中间件、celery 任务、`config.py` 2 个审计配置项改名 + 2 个限流配置新增；
  2. §3 迁移由 2 个变 3 个：凭据表 RENAME + 加列、访问审计表 RENAME、`operation_audit_logs` 加列；RENAME 迁移 downgrade 必须反向；
  3. E1 审计行 `target_type` 改为 `agent_api_key`（历史行不回填）；
  4. §7 key service 单测路径随 service 挪到 `tests/services/agent/`；既有 external 测试更新 import；
  5. §8 加部署前检查（VPS env grep、auth flag 取值确认、引用面排查）与 RENAME 窗口期说明；回滚 `downgrade -3`；
  6. §2.3 补 3 处文档 banner 改动。
- **v0.3（2026-08-04）**：打磨——
  1. E4 去掉"临时写路由桩"依赖：P0 用 service 层单测 + health 读不落审计断言覆盖，路由级写审计断言归 P2；
  2. confirm 失败状态码固定（过期 409 / body 不匹配或 token 无效 400 / idempotency 冲突 409），对齐设计稿 §5.3；
  3. S3 明确 confirm 预览返回 HTTP 200；S4 补 body-hash 绑定与 Idempotency-Key 冲突分支；
  4. §5.1 补审计映射规则（`target_type="shipment_schedule"`、`target_id=schedule.id`）与 PATCH last-write-wins 并发语义；
  5. §3 补 `Idempotency-Key` 头校验规则（非空 ≤64 字符，不强制 UUID）；
  6. §6.1 标注该页是凭据管理第一个 UI，兼看存量 external key。
- **v0.2（2026-08-04）**：按代码 review 修订——
  1. 凭据改为扩展 BEL-377 `external_api_keys` + `/api/v1/internal/api-keys`，删除虚构的 `agent_tokens` / `system_management/agent_tokens.py`；
  2. 所有 service 函数名改为代码里真实存在的名字（`list_shipment_schedules`、`create_shipment_schedule`、`update_shipment_schedule`、`replace_shipment_schedule_items`、`calculate_shipment_schedule_costs`、`list_shipment_sku_summary`、`list_shipment_fba_box_details`）；
  3. 删除虚构的 `transition_status` / `add_items` / `audit_log_service.query`，改为真实路径（状态走 `update_shipment_schedule` 薄封装；审计查询函数标注为新增）；
  4. `cost-calculate` 改名 `recalculate-costs` 并归类为**写操作**（真实 service 会回写费用字段，非纯计算）；
  5. 状态示例 `shipped` → 真实词表 `in_transit`（`ALLOWED_SHIPMENT_STATUS = draft/in_transit/completed`）；
  6. 创建 payload 改为真实 `ShipmentScheduleCreate` 字段（无 `expected_arrival_date`，日期为 `etd_date/eta_date`；items 为独立的替换步骤，端点层复合）；
  7. items 语义由"追加"改为**替换**（对齐 `replace_shipment_schedule_items`）；
  8. 读操作不落审计（`append_operation_view_log` 已是 no-op），E4/S1 断言相应修正；
  9. hash 由 bcrypt 改为 SHA-256（对齐 `api_key_service.hash_key`）；主键对齐 Integer house style；
  10. 限流改为 slowapi 内存 Limiter（对齐 `external_security.py`）；
  11. 前端页面由不存在的 `dashboard/settings/` 改到真实的 `dashboard/system/`。
- **v0（2026-08-04）**：初稿。
