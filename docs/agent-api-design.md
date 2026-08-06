# Agent API 设计文档（v0.5 — 开放货件删除版）

> **状态**：v0.5 — 开放货件删除给 Agent（confirm 两步，§3.2 白名单同步），待评审通过后进入 P0 实施。
> **范围**：定义 `/api/v1/agent/*` 命名空间的鉴权契约、危险动作 confirm 流、响应壳、错误码、审计归因与路径迁移策略。**P0 不做 scope/权限细分**——只做"你是哪个 agent"的身份校验。

---

## 1. 设计目标与边界

### 1.1 三层 API 划分

```
/api/v1/internal/...    ← 人/UI/内部 RPC（不动）
/api/v1/agent/...       ← Agent 专用：读 + 写 + confirm（替代原 /api/v1/external/*）
```

- **`/api/v1/internal/*`**：现有内部写入接口完全不动，避免影响 UI/定时任务/内部 RPC。
- **`/api/v1/agent/*`**：面向 LLM Agent 的 API，承担读与写两种动作；写动作里的危险类别（涉及金钱/不可逆状态）强制走 confirm 流。
- 原 **`/api/v1/external/*`** 过渡期保留 + 标 deprecated，最终迁移到 `/api/v1/agent/*`（见 §6）。

### 1.2 设计原则

1. **server 不替 Agent 做授权决策**：P0 只校验"你是哪个 agent"（身份），不校验"你能做什么"（授权）。授权策略由调用方（Agent 平台）按 token 维度配置。
2. **写动作默认要 confirm**：涉及金钱/不可逆状态的写接口，Agent 不能绕过用户直接落库。
3. **失败响应可被 Agent 自纠**：稳定错误码 + 人类可读 + Agent 下一步提示。
4. **审计归因简洁**：在现有 `operation_audit_logs` 上加字段即可，不引入额外维度。
5. **路径迁移不破坏现有消费者**：双挂 + 301 重定向两阶段切换。
6. **复用既有凭据基建（BEL-377）并同步改名**：仓库已有 `external_api_keys` 表 + `/api/v1/internal/api-keys` 管理端点 + `api_key_service`——Agent 凭据**改名 + 扩展这套**（`external_api_keys` → `agent_api_keys`），不另起炉灶（见 §4、§11）。

---

## 2. 鉴权契约 v0

### 2.1 必备头

| Header | 必填 | 含义 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <key_secret>`。secret 是 server 颁发的长字符串（与现有 external key 同一形态） |
| `X-Agent-Id` | ✅ | Agent 的稳定标识（业务主键），用于审计归因和后续"对照关系"扩展 |
| `Content-Type` | 写时 ✅ | `application/json` |
| `Idempotency-Key` | 写时推荐 | UUID v4；缺失时审计行上打 `no_idempotency` 标记（写入 `after_json`），但不阻断 |
| `X-Confirm-Token` | 危险动作回放时 ✅ | 第一次调用返回的 `confirm_token`，二次确认时必须回传 |

> **说明**：Authorization 里**只放 secret**；`X-Agent-Id` 单独传。UI 生成凭据时把两者分开展示，不拼成一个复合字符串。

**明确不接受的凭据形式**（与 external 通道的差异，P0 契约保持最窄）：

| 凭据形式 | external 通道 | agent 通道 |
|---|---|---|
| `Authorization: Bearer` | ✅ | ✅（唯一接受） |
| `X-API-Key` 头 | ✅ | ❌ |
| `?api_key=` 查询兜底（Vercel edge 会剥 auth 头） | ✅ | ❌ |
| `?skip_auth=true` 过渡旁路 | ✅ | ❌ |
| master key（`settings.api_key`） | ✅ | ❌ |

> Agent 是服务端消费者，直连后端（`BACKEND_API_BASE_URL`），**不经过** Next.js 代理 `frontend/app/api/backend/[...path]/route.ts`（那是浏览器侧的通道，靠 `X-API-Key` + 用户上下文头工作）。前端"Agent 凭据管理"页走既有代理调 `/api/v1/internal/api-keys`，不受本节约束。

### 2.2 校验流程

按顺序执行，任一失败立即返回错误：

```
1. Authorization 存在 → 解析 Bearer token → SHA-256 后查 agent_api_keys.key_hash
   （表在 P0 由 external_api_keys 改名而来，见 §11）
   不通过 → 401 / reason: token_invalid
2. key.is_revoked = false AND (key.expires_at IS NULL OR key.expires_at > NOW())
   不通过 → 401 / reason: token_revoked | token_expired
3. X-Agent-Id == key.agent_id（新列，见 §4）
   不通过 → 401 / reason: agent_id_mismatch
4. (预留) project_scope 校验
   不通过 → 403 / reason: project_out_of_scope
   ← P0 此步**不做强制校验**，仅留字段
```

校验通过后更新 `agent_api_keys.last_used_at`（现有列，随表改名保留）。**节流**：同一 key 距上次更新不足 60s 则跳过，避免高频读造成热写。

**存量凭据与新命名空间的行为矩阵**（过渡期重要）：

| 凭据 | 调 `/api/v1/external/*` | 调 `/api/v1/agent/*` |
|---|---|---|
| 存量 external key（`agent_id IS NULL`） | ✅ 现状不变 | ❌ 401 `agent_id_mismatch` |
| Agent key（`agent_id` 非空） | ✅（同一张表，过渡期通用） | ✅ 且 `X-Agent-Id` 匹配 |

### 2.3 失败响应统一壳

```json
// 401
{
  "ok": false,
  "error": {
    "code": "AGENT_AUTH_FAILED",
    "reason": "token_invalid | token_expired | token_revoked | agent_id_mismatch",
    "human_message": "Agent 鉴权失败",
    "agent_hint": "请确认 Authorization 与 X-Agent-Id 配对正确；如凭据失效请联系管理员重新生成"
  }
}

// 403
{
  "ok": false,
  "error": {
    "code": "AGENT_PROJECT_OUT_OF_SCOPE",
    "human_message": "本凭据未被授权访问该项目",
    "agent_hint": "请在 Agent 平台为该 agent 配置项目访问权限"
  }
}
```

### 2.4 Agent ↔ 凭据对照关系（扩展位）

每个 Agent 可以签发多张 key（用于轮换），但每张 key 必须绑定到**唯一** `agent_id`。后续 agent ↔ 业务实体（用户、项目、店铺）的映射表都以外键关联 `agent_id`，不需要再改凭据表。

```
agent_id (业务主键，外部 Agent 平台生成，稳定不变)
   ↓ 1:N
agent_api_keys (现有 external_api_keys 表 P0 改名 + 扩展 agent_id 列)
```

---

## 3. 危险动作 confirm 流

### 3.1 协议

**第一次调用（预览，server 不落库）**
```
POST /api/v1/agent/projects/{id}/shipments
Authorization: Bearer <key_secret>
X-Agent-Id: <agent_id>
Idempotency-Key: <uuid>
Content-Type: application/json

{ ...完整参数... }
```

**响应**
```json
{
  "ok": false,
  "requires_confirmation": true,
  "confirm_token": "cf_xxx",
  "preview": {
    "action": "shipment.create",
    "summary": { ...由路由层按动作生成的影响摘要... }
  },
  "expires_in_sec": 300,
  "human_message": "该操作将创建货件并产生费用，请向用户确认后继续",
  "agent_hint": "向用户复述上述摘要；用户确认后用同一 Idempotency-Key + X-Confirm-Token 重新调用同一接口"
}
```

**第二次调用（真正落库）**
```
POST /api/v1/agent/projects/{id}/shipments
Authorization: Bearer <key_secret>
X-Agent-Id: <agent_id>
Idempotency-Key: <uuid>          ← 必须与第一次相同
X-Confirm-Token: cf_xxx          ← 必须匹配 confirm_token
Content-Type: application/json

{ ... }
```

校验：
- `Idempotency-Key` 必须与第一次相同（避免并发覆盖）
- `X-Confirm-Token` 必须等于第一次返回的 `confirm_token`
- **请求体必须与预览时完全一致**：confirm_token 在 Redis 里与请求体的 SHA-256 一起存储，重放时比对 body hash——防止"预览小改动、确认大改动"
- `confirm_token` 必须未过期（默认 300s）
- 校验失败返回 `CONFIRM_TOKEN_INVALID | CONFIRM_TOKEN_EXPIRED | IDEMPOTENCY_KEY_CONFLICT`

`confirm_token` 存 Redis（现有 `app/services/infra` 提供 Redis 客户端），key=`{redis_key_prefix}:agent:confirm:{token}`，value 含 `{agent_id, action, idempotency_key, body_hash, created_at}`，逻辑 TTL=300s（物理 TTL=2×，以区分过期与不存在），**原子 pop（Lua GET+DEL）用后即删**——并发重放只有一个能取到 token（P2 准入门槛）。

> **HTTP 状态约定**：confirm 预览响应返回 **HTTP 200** + `ok:false, requires_confirmation:true`——这是协议内的正常一步，不是错误；让 Agent 用统一的成功解析路径处理它。真正的失败（token 过期/不匹配）才返回 4xx（见 §5.3）。

### 3.2 confirm 白名单（路由级装饰器集中维护）

| 动作 | 是否 confirm |
|---|---|
| 列表 / 详情 / sku-summary / fba-box-detail | ❌ 不需要 |
| 创建货件 | ⚠️ 是 |
| 修改货件字段（PATCH） | ⚠️ 是 |
| 替换 items | ⚠️ 是 |
| 推进 status（任意 to_status） | ⚠️ 是（不可逆） |
| 重算费用（recalculate-costs，见 spec §5） | ⚠️ 是（会回写费用字段） |
| 删除货件（DELETE /{shipment_no}） | ⚠️ 是（不可逆） |
| 隐藏（shipment batch hidden） | ❌ 不开放给 Agent（admin only） |

> 通过一个 FastAPI 装饰器 `@require_confirmation(action="shipment.create")` 集中表达，handler 在第一次调用时返回 confirm 壳，第二次调用时才执行真正的 service 调用。

### 3.3 读操作的审计策略（review 修订）

现有 `append_operation_view_log` 已被有意改为 **no-op**（"passive page-load and data-fetch events generate too much noise"）。Agent 读操作**沿用同一决策：不落审计行**。只有**写操作**（含 confirm 回放成功那次）写 `operation_audit_logs`。这样既保持口径一致，也避免高频读把审计表打爆。

---

## 4. 数据模型（review 修订：复用 BEL-377 凭据基建）

### 4.1 关键决策：改名 + 扩展 `external_api_keys` → `agent_api_keys`，不新建表

仓库已有 BEL-377 的应用层凭据体系：

| 既有资产 | 位置 |
|---|---|
| `external_api_keys` 表（`key_hash` SHA-256、`key_prefix`、`label`、`scope`（默认 `"read"`，注释写明"reserved for P2 per-key scope restrictions"）、`is_revoked`、`expires_at`、`created_by`、`last_used_at`） | `app/models/external_api_key.py`（P0 改名为 `agent_api_key.py` / `AgentApiKey`，见 §11） |
| 管理端点 `POST/GET /api/v1/internal/api-keys`、`POST /api/v1/internal/api-keys/{id}/revoke` | `app/api/v1/endpoints/internal/api_keys.py`（挂载于 `app/api/v1/router.py:126`） |
| `generate_key / create_api_key / resolve_key / revoke_api_key` | `app/services/external/api_key_service.py`（P0 迁至 `app/services/agent/key_service.py`，函数名不动） |
| 鉴权 + 限流依赖 | `app/api/external_security.py`（slowapi Limiter，内存存储；agent 通道另建 `app/api/agent/auth.py`，模式沿用） |

Agent 凭据 = external key + `agent_id` 绑定。P0 只做一次小迁移（**表改名 + 加列同一迁移完成**，RENAME 是 PG 目录级操作、毫秒级不重写数据）：

```python
# Alembic（rev-id 顺延现有序号，遵循 AGENTS.md 迁移规范；downgrade 必须反向 RENAME）
op.rename_table("external_api_keys", "agent_api_keys")
op.execute("ALTER INDEX idx_eak_key_hash RENAME TO idx_aak_key_hash")
op.execute("ALTER INDEX idx_eak_revoked_expires RENAME TO idx_aak_revoked_expires")
op.add_column("agent_api_keys", sa.Column("agent_id", sa.String(128), nullable=True))
op.add_column("agent_api_keys", sa.Column("project_scope", sa.String(255), nullable=False, server_default="*"))
op.create_index("idx_aak_agent_id", "agent_api_keys", ["agent_id"])
```

- 存量 key `agent_id = NULL` → 仅可读 external 命名空间（现状不变）。
- 新建 agent key 时 `agent_id` 必填；`X-Agent-Id` 头与之比对。
- `scope` 列已存在（默认 `"read"`）——P0 不启用校验，留作后续授权扩展。
- 管理端点扩展：`POST /api/v1/internal/api-keys` 增加可选 body 字段 `agent_id`；带 `agent_id` 的创建即"Agent 凭据"。**不新建 `system_management/agent_tokens.py`**——避免两套凭据管理入口。

### 4.2 `operation_audit_logs` 加两个字段

```python
op.add_column("operation_audit_logs", sa.Column("agent_id", sa.String(128), nullable=True))
op.add_column("operation_audit_logs", sa.Column("idempotency_key", sa.String(64), nullable=True))
op.create_index("idx_oal_agent_id", "operation_audit_logs", ["agent_id"])
```

`append_operation_audit_log`（`app/services/audit_log_service.py`）增加可选 kwargs `agent_id=None, idempotency_key=None`；FastAPI 依赖把 `X-Agent-Id` / `Idempotency-Key` 注入 `request.state`，写路径的 service 调用处传入。

**`operator` 语义**：Agent 发起的写操作 `operator=NULL`，归因走 `agent_id` 列；人用 UI 的写操作维持现状（`operator`=用户名）。**不改 `operator` 语义**，避免影响现有审计展示。

### 4.3 模型书写规范（对齐 house style）

- 主键 `Integer`（对齐改名后的 `agent_api_key.py` / `alert_rule.py`，**禁用 BigInteger**——见 `AGENTS.md`）
- `Mapped[...]` 注解 + `DateTime(timezone=True)` + `server_default=func.now()`
- hash 用 SHA-256 hex（`String(64)`），**不用 bcrypt**——与 `api_key_service.hash_key` 一致
- 明文只在创建响应里返回一次，库里只存 hash（现有行为，直接沿用）

---

## 5. 响应壳与错误码注册表

### 5.1 统一响应壳

```json
// 成功
{ "ok": true, "data": {...}, "idempotency_key": "..." }

// 失败（可自纠）
{
  "ok": false,
  "error": {
    "code": "SHIPMENT_ITEMS_INVALID_SKU",
    "human_message": "...",
    "agent_hint": "...",
    "details": [...]
  }
}

// 失败（需 confirm）
{
  "ok": false,
  "requires_confirmation": true,
  "confirm_token": "...",
  "preview": {...},
  "expires_in_sec": 300,
  "human_message": "...",
  "agent_hint": "..."
}
```

### 5.2 错误码注册表（`app/api/agent/errors.py`）

错误码集中在 `app/api/agent/errors.py` 用 `Enum` 注册，**所有新增错误码必须走该文件**——避免错误码漂移（Agent 提示词依赖稳定 code）。

初始注册（P0 必须）：

```python
class ErrorCode(str, Enum):
    # 鉴权
    AGENT_AUTH_FAILED              = "AGENT_AUTH_FAILED"
    AGENT_PROJECT_OUT_OF_SCOPE     = "AGENT_PROJECT_OUT_OF_SCOPE"
    # 限流
    AGENT_RATE_LIMIT_EXCEEDED      = "AGENT_RATE_LIMIT_EXCEEDED"
    # 幂等
    IDEMPOTENCY_KEY_CONFLICT       = "IDEMPOTENCY_KEY_CONFLICT"
    # confirm
    CONFIRM_TOKEN_INVALID          = "CONFIRM_TOKEN_INVALID"
    CONFIRM_TOKEN_EXPIRED          = "CONFIRM_TOKEN_EXPIRED"
    CONFIRM_REQUIRED               = "CONFIRM_REQUIRED"
    # 通用
    VALIDATION_FAILED              = "VALIDATION_FAILED"
    RESOURCE_NOT_FOUND             = "RESOURCE_NOT_FOUND"
    INTERNAL_ERROR                 = "INTERNAL_ERROR"
```

P2 货件域再扩展（`SHIPMENT_*`）。

### 5.3 错误码 → HTTP 状态映射（固定，实现不得漂移）

| code | HTTP | 场景 |
|---|---|---|
| `AGENT_AUTH_FAILED` | 401 | token 无效/过期/吊销/agent_id 不匹配（细分在 `error.reason`） |
| `AGENT_PROJECT_OUT_OF_SCOPE` | 403 | project_scope 校验（P0 预留不启用） |
| `AGENT_RATE_LIMIT_EXCEEDED` | 429 | 限流，附 `Retry-After` |
| `VALIDATION_FAILED` | 400 | 业务校验失败（如非法状态值） |
| `SHIPMENT_ITEMS_INVALID_SKU` | 400 | 明细含不存在 SKU |
| `RESOURCE_NOT_FOUND` | 404 | 项目/货件不存在 |
| `CONFIRM_TOKEN_INVALID` | 400 | token 不存在或与 body hash 不匹配 |
| `CONFIRM_TOKEN_EXPIRED` | 409 | token 过期 |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | 同一 Idempotency-Key 被用于不同请求体 |
| `INTERNAL_ERROR` | 500 | 未分类异常（不向 Agent 暴露堆栈） |
| （confirm 预览，非错误） | **200** | `ok:false, requires_confirmation:true`（见 §3.1） |

> FastAPI 原生 422 schema 校验错误也要在命名空间级异常处理器里包装成 `VALIDATION_FAILED` 壳——Agent 只面对一种错误结构。

---

## 6. 路径迁移策略

### 6.1 三阶段切换

**v1（已完成，2026-08-06）**：双挂 + 老路径标 deprecated
- 注册新路由到 `/api/v1/agent/*`（挂载点：`app/api/v1/router.py` 的 `api_router.include_router(...)`，与 `external_router` 并列）
- 老的 `/api/v1/external/*` 继续工作，响应头加 `Deprecation: true`、`Sunset: <日期>`、`Link: </api/v1/agent/...>; rel="successor-version"`

**v2（跳过）**：原计划 301 跳转过渡。实际核查近 14 天审计日志发现
`/external/*` 无真实消费者（全部流量为本机/测试探测），且存量
`agent_id IS NULL` 的 external key 为 0——用户决策**直接进入 v3**。

**v3（已完成，2026-08-06）**：彻底下掉老路径
- `app/api/v1/router.py` 不再挂载 `external_router`；旧命名空间由
  `app/api/v1/endpoints/external_retired.py` 兜底返回 **410 Gone** +
  `Link: rel="successor-version"` 指向对应 `/agent/*` 路径（比裸 404 更明确）。
- 移除 `app/middleware/external_deprecation.py`（Deprecation/Sunset 头随
  路由下线而失去意义）与 `Settings.external_api_sunset`。
- external 模块保留为 `agent/external_mirror.py` 的 handler 来源，不再挂载。
- 测试：删除 10 个打旧路由的 `test_external_*.py`（API 已下线）；
  agent 镜像 parity 改为直调 external handler 函数比对；新增 410 契约测试。
- 消费者：believeboySP `scripts/ad_analysis/load_data.py` 已切到
  `/api/v1/agent` + Bearer/X-Agent-Id 鉴权 + `{ok,data}` 解壳（调用方形状不变）。
  **BLF-464（2026-08-06）**：believeboySP 整体已删除（git 历史可恢复，
  `git checkout <commit> -- believeboySP/`）。未来新 Agent 一律走「Agent 接入
  管理」页创建 key + ID，不再使用该直连脚本。

### 6.2 映射关系

现有 `/external/*` 每个 GET 路由一对一映射到 `/agent/*`（如 `/external/projects/{id}/sku-info` → `/agent/projects/{id}/sku-info`）。`/agent/*` 独有的写路由（shipments 等）不存在映射问题。

**对照表（BLF-459 P1 落地，共 51 条 GET 路由）**：镜像由
`backend/app/api/v1/endpoints/agent/external_mirror.py` 从 `external_router`
**程序化生成**（同后缀路径 + 复用 external handler 沿 ``__wrapped__`` 保留
签名 + 壳翻译），未来新增 external 读路由自动出现在 agent 侧。下表由脚本枚举生成：

| 老路径 (`/external`) | 新路径 (`/agent`) | 状态 |
|---|---|---|
| `/external/projects` | `/agent/projects` | v1 双挂（project_scope 过滤列表） |
| `/external/projects/{project_id}/ad-campaigns` | `/agent/projects/{project_id}/ad-campaigns` | v1 双挂 |
| `/external/projects/{project_id}/ad-campaigns-raw` | `/agent/projects/{project_id}/ad-campaigns-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-campaign-raw` | `/agent/projects/{project_id}/ad-campaign-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-terms` | `/agent/projects/{project_id}/ad-search-terms` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-terms-raw` | `/agent/projects/{project_id}/ad-search-terms-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-term-raw` | `/agent/projects/{project_id}/ad-search-term-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-budgets` | `/agent/projects/{project_id}/ad-budgets` | v1 双挂 |
| `/external/projects/{project_id}/ad-budgets-raw` | `/agent/projects/{project_id}/ad-budgets-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-budget-raw` | `/agent/projects/{project_id}/ad-budget-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-targets` | `/agent/projects/{project_id}/ad-targets` | v1 双挂 |
| `/external/projects/{project_id}/ad-targets-raw` | `/agent/projects/{project_id}/ad-targets-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-target-raw` | `/agent/projects/{project_id}/ad-target-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-placements` | `/agent/projects/{project_id}/ad-placements` | v1 双挂 |
| `/external/projects/{project_id}/ad-placements-raw` | `/agent/projects/{project_id}/ad-placements-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-placement-raw` | `/agent/projects/{project_id}/ad-placement-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-promoted-products` | `/agent/projects/{project_id}/ad-promoted-products` | v1 双挂 |
| `/external/projects/{project_id}/ad-promoted-products-raw` | `/agent/projects/{project_id}/ad-promoted-products-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-promoted-product-raw` | `/agent/projects/{project_id}/ad-promoted-product-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-time-trends` | `/agent/projects/{project_id}/ad-time-trends` | v1 双挂 |
| `/external/projects/{project_id}/ad-time-trends-raw` | `/agent/projects/{project_id}/ad-time-trends-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-time-trend-raw` | `/agent/projects/{project_id}/ad-time-trend-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-term-shares` | `/agent/projects/{project_id}/ad-search-term-shares` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-term-shares-raw` | `/agent/projects/{project_id}/ad-search-term-shares-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-search-term-share-raw` | `/agent/projects/{project_id}/ad-search-term-share-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-invalid-traffic` | `/agent/projects/{project_id}/ad-invalid-traffic` | v1 双挂 |
| `/external/projects/{project_id}/ad-invalid-traffic-raw` | `/agent/projects/{project_id}/ad-invalid-traffic-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-purchased-products` | `/agent/projects/{project_id}/ad-purchased-products` | v1 双挂 |
| `/external/projects/{project_id}/ad-purchased-products-raw` | `/agent/projects/{project_id}/ad-purchased-products-raw` | v1 双挂 |
| `/external/projects/{project_id}/ad-purchased-product-raw` | `/agent/projects/{project_id}/ad-purchased-product-raw` | v1 双挂 |
| `/external/projects/{project_id}/orders/summary` | `/agent/projects/{project_id}/orders/summary` | v1 双挂 |
| `/external/projects/{project_id}/business-summary` | `/agent/projects/{project_id}/business-summary` | v1 双挂 |
| `/external/projects/{project_id}/replenishment-analysis` | `/agent/projects/{project_id}/replenishment-analysis` | v1 双挂 |
| `/external/projects/{project_id}/sku-info` | `/agent/projects/{project_id}/sku-info` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/months` | `/agent/projects/{project_id}/inventory-ledger/months` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/snapshot` | `/agent/projects/{project_id}/inventory-ledger/snapshot` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/events` | `/agent/projects/{project_id}/inventory-ledger/events` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/receipt-clusters` | `/agent/projects/{project_id}/inventory-ledger/receipt-clusters` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/integrity` | `/agent/projects/{project_id}/inventory-ledger/integrity` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/trend` | `/agent/projects/{project_id}/inventory-ledger/trend` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/detail` | `/agent/projects/{project_id}/inventory-ledger/detail` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/summary` | `/agent/projects/{project_id}/inventory-ledger/summary` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/batches` | `/agent/projects/{project_id}/inventory-ledger/batches` | v1 双挂 |
| `/external/projects/{project_id}/inventory-ledger/consistency` | `/agent/projects/{project_id}/inventory-ledger/consistency` | v1 双挂 |
| `/external/projects/{project_id}/return-analysis` | `/agent/projects/{project_id}/return-analysis` | v1 双挂 |
| `/external/projects/{project_id}/return-analysis-raw` | `/agent/projects/{project_id}/return-analysis-raw` | v1 双挂 |
| `/external/projects/{project_id}/shop-calculation-history` | `/agent/projects/{project_id}/shop-calculation-history` | v1 双挂 |
| `/external/projects/{project_id}/shop-calculation/snapshots` | `/agent/projects/{project_id}/shop-calculation/snapshots` | v1 双挂 |
| `/external/projects/{project_id}/pricing-snapshots` | `/agent/projects/{project_id}/pricing-snapshots` | v1 双挂 |
| `/external/projects/{project_id}/new-product-calculations` | `/agent/projects/{project_id}/new-product-calculations` | 已原生迁移（BLF-457 agent R1 同路径） |

---

## 7. 限流与幂等（P0 最小可用，review 修订）

### 7.1 限流：复用 slowapi 模式

现有 `external_security.py` 用 **slowapi `Limiter`（内存存储）**，key_func 取凭据/IP。Agent 通道沿用同一模式：

- 新建 `Limiter(key_func=get_agent_id_or_ip)`，挂 `/api/v1/agent/*` 命名空间
- 默认限额：读 300 req/min，写 30 req/min（按 agent_id 维度）；两个默认值走 `Settings`（`agent_api_read_rate_limit` / `agent_api_write_rate_limit`），可不改代码调整
- 超额返回 429 + `Retry-After` + `X-RateLimit-*` 头，body 走统一响应壳（`AGENT_RATE_LIMIT_EXCEEDED`）

> **已知限制**：内存存储 = 限额按 worker 进程独立计算（与现有 external limiter 同样的取舍）。当前部署规模下可接受；若未来多 worker 需要全局限额，再接 Redis 存储——不在 P0 范围。

### 7.2 幂等

写接口推荐 `Idempotency-Key`：
- 带 key：写入审计行 `idempotency_key` 列（§4.2），事后可按 key 追溯重放
- 缺 key：不阻断，审计行 `after_json` 里打 `{"risk": "no_idempotency"}` 标记

**P0 不做完整幂等响应缓存**（不建 `agent_idempotency_keys` 表）——完整缓存留到出现真实重复创建事故后再评估。

---

## 8. 实施阶段

| 阶段 | 范围 | 产出 |
|---|---|---|
| **P0 基础设施** | **external → agent 改名一批**（表 / 索引 / 模型 / key service / 审计中间件 / celery 任务 / 2 个审计配置项，见 §11.2）；`agent_api_keys` 加 `agent_id`/`project_scope` 列；审计表加 `agent_id`/`idempotency_key` 列；`/api/v1/agent/*` 命名空间壳 + 鉴权依赖；slowapi 限流；`AgentResponse` 响应壳；错误码注册表；confirm 装饰器（Redis）；`internal/api-keys` 端点支持 agent_id；前端"Agent 凭据管理"页（生成/吊销）；`/external/*` 加 Deprecation 头 | 基础设施可被任何域复用 |
| **P1 路径迁移** | `/api/v1/agent/*` 逐步挂载原 `/external/*` 路由（一对一） | 老消费者不断 |
| **P2 货件域写通道** | `/agent/.../shipments/*` 读写路由；接 `app.services.shipment.*`；confirm 流 | Agent 能创建/修改/推进货件状态 |
| **P3 定价/店铺/库存** | 按 P2 模板复制 | 模板化推进 |
| **P4 AI Chat 工具调用清单** | 在 `ai_chat_v2.py` 里给 Agent 注册这些 endpoint 为可调用工具 | 对话真正能驱动这些动作 |

---

## 9. 开放问题（已对齐的取舍）

| # | 问题 | 决定 |
|---|---|---|
| 1 | Token 形态 | 长 token + 可吊销（简单）。不做 refresh |
| 2 | `project_scope` 粒度 | 字段预留（`server_default='*'`），P0 不强制校验 |
| 3 | scope / 权限细分 | ❌ P0 不做（改名后 `agent_api_keys.scope` 列已预留） |
| 4 | 危险动作自动拒（audit_only 模式） | ❌ 不做；用 confirm 流 |
| 5 | 审计归因 | `operation_audit_logs.agent_id` + `idempotency_key` 两列；读不落审计 |
| 6 | Token 颁发方式 | **C 起步**：P0 扩展现有 `/api/v1/internal/api-keys` + 前端管理页；后续按需增强 |
| 7 | 完整幂等缓存 | ❌ P0 不做；审计留痕即可 |
| 8 | 凭据表选型（review 新增） | **改名 + 扩展现有 `external_api_keys` → `agent_api_keys`**，不新建 `agent_tokens` 表；改名矩阵与部署窗口见 §11 |
| 9 | 限流实现（review 新增） | **slowapi 内存 Limiter**（对齐现有 external limiter），不手写 Redis 令牌桶 |
| 10 | 货件状态词表（review 新增） | **P0 沿用现有三态 `draft / in_transit / completed`**。Agent 场景若需新状态（如"已取消"），属 service 层 + 前端联动的变更，单独评估，不在本设计开口子 |

---

## 10. 参考与索引

- 原 `/api/v1/external/*` 路由装配：`backend/app/api/v1/endpoints/external/__init__.py`
- 现有外部鉴权 + 限流：`backend/app/api/external_security.py`
- 现有凭据模型 / 服务 / 管理端点：`app/models/external_api_key.py`、`app/services/external/api_key_service.py`、`app/api/v1/endpoints/internal/api_keys.py`（挂载 `app/api/v1/router.py:126`）——P0 后分别变为 `app/models/agent_api_key.py`、`app/services/agent/key_service.py`，端点路径不变
- 访问审计中间件 + 保留期清理：`app/middleware/external_audit.py`、`app/celery_tasks/external_audit_cleanup.py`（beat 注册在 `app/tasks/celery_app.py:54/91/121`）——P0 后变为 `agent_api_audit.py` / `agent_api_audit_cleanup.py`
- 货件内部接口样例：`backend/app/api/v1/endpoints/shipment_schedules.py`（`Depends(protected)` + `append_operation_audit_log`）
- 货件 service 层：`backend/app/services/shipment/{schedule,item,summary,serialization,validation}.py`
- 内部审计：`backend/app/services/audit_log_service.py`（`append_operation_audit_log`；`append_operation_view_log` 已为 no-op）
- 外部 API 文档（P0 只读契约）：`backend/docs/external-api.md`
- 网关隔离配置：`docs/deployment/external-api-network-isolation.md`
- 运营 Agent 数据对接全景图：`docs/external-api-ops-agent-roadmap.md`

---

## 11. 术语与命名同步计划（external → agent）

> **总原则：名字跟着命名空间走。** 面向未来的共享基建（凭据、访问审计）改新名（agent）；绑定遗留 `/external/*` 读命名空间的东西保留旧名，直到该命名空间退役。**改名在 P0 一次做完**，与代码原子部署，不允许跨版本半改。

### 11.1 现状盘点（代码事实）

| 类别 | 资产 |
|---|---|
| 生产表（2） | `external_api_keys`、`external_api_audit_log` |
| ORM 模型（2 文件） | `app/models/external_api_key.py`、`app/models/external_api_audit_log.py` + `__init__.py` 导出 |
| 配置项（6） | `external_api_require_auth` / `external_api_allow_skip_auth` / `external_api_rate_limit_enabled` / `external_api_rate_limit`（以上 4 个管 `/external/*`）；`external_api_audit_enabled` / `external_api_audit_retention_days`（管访问审计） |
| 后端包（3） | `app/api/v1/endpoints/external/`（25 个端点模块）、`app/services/external/`（12 个查询服务）、`app/api/external_security.py` |
| 中间件 + Celery | `app/middleware/external_audit.py`；`app/celery_tasks/external_audit_cleanup.py`（beat 3 处引用） |
| 迁移历史 | `20260802_227_add_external_api_keys.py`（已应用，不改） |
| 文档（3） | `backend/docs/external-api.md`、`docs/deployment/external-api-network-isolation.md`、`docs/external-api-ops-agent-roadmap.md` |
| 前端消费方（1 处真实引用） | `frontend/lib/server/backend-cache.ts:133` 的 `/external/projects/{id}/ad-upload-files` URL pattern（P1 迁移时同步改） |

### 11.2 改名矩阵 —— 现在就改（P0，与代码原子部署）

| 层 | 现名 | 新名 | 说明 |
|---|---|---|---|
| DB 表 | `external_api_keys` | `agent_api_keys` | `ALTER TABLE ... RENAME TO`（PG 目录级操作，毫秒级，不重写数据）；与加列同一迁移 |
| DB 表 | `external_api_audit_log` | `agent_api_audit_log` | 同上 |
| 索引 | `idx_eak_*` | `idx_aak_*` | PG RENAME 表后索引保留旧名，同迁移顺手改 |
| 模型 | `ExternalApiKey`（`models/external_api_key.py`） | `AgentApiKey`（`models/agent_api_key.py`） | `models/__init__.py` 同步 |
| 模型 | `ExternalApiAuditLog`（`models/external_api_audit_log.py`） | `AgentApiAuditLog`（`models/agent_api_audit_log.py`） | 同上 |
| 服务 | `app/services/external/api_key_service.py` | `app/services/agent/key_service.py`（新包） | **函数名不动**（`generate_key`/`create_api_key`/`resolve_key`/`revoke_api_key` 本就通用），只挪模块路径；`external_security.py` 的 import 指向新位置 |
| 中间件 | `app/middleware/external_audit.py` | `app/middleware/agent_api_audit.py` | 前缀列表同时覆盖 `/api/v1/external/*` 与 `/api/v1/agent/*`（过渡期双命名空间都记访问日志） |
| Celery 任务 | `external_audit_cleanup` | `agent_api_audit_cleanup` | `celery_app.py` 的 beat 注册 / queue 路由 / task 路径 **3 处同步** |
| 配置 | `external_api_audit_enabled` / `external_api_audit_retention_days` | `agent_api_audit_enabled` / `agent_api_audit_retention_days` | ⚠️ 部署前检查 VPS env 是否设置了旧名（见 §11.5） |

### 11.3 保留旧名（随 `/external/*` 退役处理，P0 不动）

| 资产 | 理由 |
|---|---|
| `/api/v1/external/*` 路由 + `external_router` | 遗留读命名空间，按 §6.1 v2/v3 阶段退役 |
| `app/api/v1/endpoints/external/`（25 模块） | 同上；P1 在 `/agent/*` 镜像挂载时再评估搬迁 |
| `app/services/external/` 查询服务（aggregator / ad_rows_query / business_summary 等 12 个） | `/external/*` 的查询层，与命名空间同进退 |
| `app/api/external_security.py`（`require_external_api_key` / `require_external_rate_limit` / `external_limiter`） | 专管 `/external/*` 过渡期鉴权；agent 通道用新的 `app/api/agent/auth.py` |
| 配置 `external_api_require_auth` / `external_api_allow_skip_auth` / `external_api_rate_limit_enabled` / `external_api_rate_limit` | `/external/*` 专用开关；agent 通道鉴权 day-1 强制、限流用新配置 `agent_api_*`，不吃旧开关 |
| 测试 `tests/api/test_external_auth.py` 等 | 跟随代码改动更新 import 与表名断言；测试场景本身保留 |

### 11.4 文档同步

| 文档 | 动作 |
|---|---|
| `backend/docs/external-api.md` | 顶部加弃用 banner → 指向 `docs/agent-api-design.md`；文件保留（描述遗留契约至退役） |
| `backend/docs/agent-api.md` | **新建**（P0 交付，用户面向使用文档） |
| `docs/external-api-ops-agent-roadmap.md` | 顶部加术语说明（文中"external API"此后按"Agent API · 读侧"理解）；文件名保留（历史规划文档） |
| `docs/deployment/external-api-network-isolation.md` | 顶部加说明：`/api/v1/agent/*` 沿用同一网关隔离策略 |
| `docs/REFERENCE.md` | Backend API 节指针（已加） |
| `frontend/lib/server/backend-cache.ts` | P1 路由迁移时同步 URL pattern（P0 不动） |

### 11.5 风险与部署窗口分析（诚实版）

1. **迁移-重启窗口**：deploy 脚本顺序是 `alembic upgrade head` → `systemctl restart`。RENAME 瞬间生效后、旧代码停掉前的几秒窗口内：
   - `external_api_keys`：`external_api_require_auth` 默认关 → 旧代码不碰此表 → **无影响**（若 VPS 已开启该 flag，窗口内 external 请求会 401/500，需知悉）
   - `external_api_audit_log`：审计中间件"永不破坏请求"（所有 DB 操作包裹吞错）→ 窗口内**静默丢几行审计**，可接受
2. **Celery 换名**：旧 worker 队列里若残留旧名任务，新 worker 不识别 → 该任务每日一次且幂等，最坏漏一次清理、次日补上
3. **VPS env 检查（部署前必做）**：`grep EXTERNAL_API <env 文件>`——若设置了 `EXTERNAL_API_AUDIT_ENABLED` / `EXTERNAL_API_AUDIT_RETENTION_DAYS`，需同步改成 `AGENT_API_*`，否则新配置落回默认值
4. **Alembic downgrade**：RENAME 迁移的 downgrade 必须包含反向 RENAME，保证可回退
5. **为什么不等退役再改表名**：P0 迁移本就要给凭据表加列，RENAME 捎带只做一次；两张表都没有仓库外直接查询方（BI 消费的是 HTTP API，不直连表），爆炸半径可控

---

## 修订记录

- **v0.5（2026-08-05）**：开放货件删除给 Agent——
  1. §3.2 白名单「删除 / 隐藏」拆行：删除货件（DELETE）开放并走 confirm 流（action `shipment.delete`，不可逆）；隐藏（shipment batch hidden）仍保持 admin only；
  2. 新增 Agent 端点 `DELETE /api/v1/agent/projects/{project_id}/shipments/{shipment_no}`：预览（含货件状态 / 明细条数 / 总量）→ token → 重放删除；审计 action `shipment.delete`（before 记录被删货件信息，operator=NULL + agent_id 归因）。
- **v0.4（2026-08-04）**：术语与命名同步——
  1. 新增 §11：external → agent 改名计划（现状盘点 / 改名矩阵 / 保留旧名清单 / 文档同步 / 部署窗口风险）；
  2. 凭据表策略升级为"改名 + 扩展"：`external_api_keys` → `agent_api_keys`，RENAME 与加列同一迁移（§4.1）；
  3. §1.2 / §2.2 / §2.4 / §4.3 / §8 / §9 / §10 内联引用同步为新名；
  4. 总原则：名字跟着命名空间走——共享基建 P0 一次改完，绑定 `/external/*` 遗留命名空间的保留旧名至退役。
- **v0.3（2026-08-04）**：打磨——
  1. §2.1 增加"不接受的凭据形式"对照表（X-API-Key / ?api_key= / ?skip_auth=true / master key 全部不走 agent 通道）+ Agent 直连后端、不经 Next.js 代理的说明；
  2. §2.2 增加存量凭据 × 命名空间行为矩阵 + `last_used_at` 60s 节流；
  3. §3.1 confirm_token 与请求体 SHA-256 绑定（防"预览小改动、确认大改动"）；明确 confirm 预览返回 HTTP 200；
  4. 新增 §5.3 错误码 → HTTP 状态固定映射表（含 422 统一包装为 VALIDATION_FAILED）；
  5. §7.1 限流默认值走 Settings 可调；
  6. §9 新增开放问题 #10：状态词表 P0 不扩。
- **v0.2（2026-08-04）**：按代码 review 修订——
  1. 放弃新建 `agent_tokens` 表，改为扩展 BEL-377 `external_api_keys`（加 `agent_id`/`project_scope` 列）；
  2. 主键/hash/created_by 全部对齐 house style（Integer PK、SHA-256、String(128)）；
  3. 限流改为 slowapi 内存 Limiter（对齐现有实现），放弃自写 Redis 令牌桶；
  4. 明确 Agent 读操作不落审计（与 `append_operation_view_log` no-op 决策一致）；
  5. 明确 `operator=NULL` + `agent_id` 列的归因方式；
  6. 审计迁移补上 `idempotency_key` 列，与设计 §7.2 对齐。
- **v0（2026-08-04）**：初稿。
