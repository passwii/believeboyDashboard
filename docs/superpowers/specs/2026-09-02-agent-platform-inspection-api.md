# 平台巡检 Agent API 设计（platform_inspection）

> 设计定稿 v0.1（2026-09-02，BLF-943「新增 Agent API 板块：平台巡检设计规划」）。
> 域 code：`platform_inspection`；命名空间：`/api/v1/agent/platform-inspection/*`。
> 前置设计：`docs/agent-api-design.md`（v0.9）；同数据底座的读域：`account_health`（BLF-550，spec `docs/superpowers/specs/2026-08-08-agent-account-health-api.md`）。

## 1. 文档目的与域定位

### 1.1 文档目的

承接 BLF-943「新增 Agent API 板块：平台巡检（Platform Inspector）设计规划」：
把前端「平台巡检」页面的**用户输入填写 / 提交 + 截图上传 / 删除**能力开放为 `/api/v1/agent/*` 体系下的新业务域。
本文档定稿域定位 / 与 account-health 的读写边界 / 端点清单 / confirm 判定 / 字段设计 / 服务层影响面 / 测试清单，
作为 S2（实施）与 S3（收尾）的锚点。

### 1.2 域定位（单域原则）

- **单域原则**（agent-api-design §1.2）：本域只服务「平台巡检（platform inspection）」一个业务域——周粒度、
  每（周期 × 店铺）一条巡检报告（账户健康评级 + 客服/配送绩效 + 政策合规分类计数）的**写侧**。
- 本域边界 = **巡检报告的填写 / 更新 / 提交 + 截图上传 / 删除**（用户诉求中的「用户输入上传 + 截图上传」）。
- **不吸收** account-health 读侧端点（见 §3 边界）；**不吸收**店铺测算 / 新品测算 / 库存等其它域端点。

## 2. 现状底座清单（代码核实）

### 2.1 数据模型（3 表，`backend/app/models/inspection.py`，零新增）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `inspection_periods` | `week_start` / `week_end` / `deadline` | 每周一行，`week_start` 唯一 |
| `inspection_reports` | `(period_id, project_id)` 唯一键；`health_data` / `compliance_data`（JSON 列但 schema 固定）；`status`(draft/overdue/submitted) / `status_summary` / `submitted_by` / `submitted_at` | 每（周期 × 店铺）一条 |
| `inspection_screenshots` | `report_id` → report；`r2_key` / `thumbnail_key` / `caption` / `sort_order` | R2 存储，接口返回 presigned URL（**agent 侧不暴露**） |

### 2.2 字段集（单一事实源 = 周巡检表单，`backend/app/schemas/inspection.py` + `inspections.py` 模板常量）

**`health_data` 8 字段**：`account_health_rating`（Healthy/Good/At Risk/Critical，select 枚举）+ `negative_feedback` / `a2z_claims` / `chargeback_claims`（warn 1 / crit 3）+ `late_shipment_rate`（warn 2.0 / crit 4.0）/ `pre_fulfillment_cancel_rate` / `valid_tracking_rate`（warn 97.0 / crit 95.0 below）/ `on_time_delivery_rate`（同）。

**`compliance_data` 10 字段**（warn 1 / crit 3）：`ip_infringement` / `ip_complaints` / `product_authenticity_complaints` / `product_condition_complaints` / `food_product_safety` / `listing_policy_violations` / `restricted_product_violations` / `review_policy_violations` / `other_policy_violations` / `regulatory_compliance`。

**`status_summary`**：自由文本（覆盖率低 ~23%，仍属表单字段，写侧可填）。

### 2.3 前端「平台巡检」现有能力（要 Agent 化的对象，`frontend/lib/inspection-api.ts` + GUI `platform_inspection.rs`）

> 注：旧 `gui/`（Rust + GPUI）已于 2026-09-13 整体删除（BLF-1041）；后续的 SwiftUI macOS 客户端现已停止并删除，桌面端后续改由 MyGo 承接。本文的 Agent API 契约不受影响。

| # | 前端动作 | 内部端点（`inspections.py`） | 写/读 |
|---|---|---|---|
| 1 | 拉模板（字段 + 阈值 + 枚举） | `GET /inspections/template` | 读 |
| 2 | 周期列表 / 当前周期 | `GET /inspections/periods`、`GET /inspections/periods/current` | 读 |
| 3 | 周期概览 | `GET /inspections/periods/{id}/overview` | 读 |
| 4 | 单店报告读 | `GET /inspections/periods/{id}/projects/{pid}` | 读 |
| 5 | **填写 / 保存草稿** | `POST /inspections/periods/{id}/projects/{pid}`（create_or_update） | **写** |
| 6 | **更新草稿** | `PATCH /inspections/periods/{id}/projects/{pid}` | **写** |
| 7 | **提交报告** | `POST /inspections/periods/{id}/projects/{pid}/submit` | **写（不可逆）** |
| 8 | **截图上传**（multipart + 压缩 + 缩略图） | `POST /inspections/screenshots/upload` | **写** |
| 9 | **截图删除** | `DELETE /inspections/screenshots/{sid}` | **写（不可逆）** |
| 10 | 历史 | `GET /inspections/history` | 读 |

其中 #5–#9 为写路径，即本域要覆盖的能力（#1–#4、#10 读侧已由 `account_health` 覆盖）。

### 2.4 服务层（`backend/app/services/inspection_service.py`，写侧复用对象）

| 函数 | 能力 | 备注 |
|---|---|---|
| `create_or_update_report(db, period_id, project_id, data, operator)` | 按 (period, project) upsert 草稿 | **`screenshot_ids` 目前是 no-op**（只 SELECT 不关联）——截图挂靠走 `upload_screenshot` 的 `report_id`，agent 写 schema **不提供 screenshot_ids** |
| `submit_report(db, report_id, operator)` | draft/overdue → submitted，写 `submitted_by` / `submitted_at`，返回 `(report, warnings)` | warnings = 阈值告警，agent 提交响应应透出 |
| `upload_screenshot(db, settings, file, report_id, project_slug)` | 类型/大小校验 + 压缩 + 缩略图 + R2 + 入库 | 复用，0 改造 |
| `delete_screenshot(db, settings, screenshot_id)` | R2 删除 + DB 行删除 | 复用，0 改造 |
| `get_report` / `get_report_by_id` / `get_period` | 读 | 归属校验用 |

## 3. 与 account-health 的读写边界（核心，D3）

**account-health（BLF-550，已上线，读侧）**：5 条纯读路由消费同一巡检数据底座，刻意**不暴露截图 presigned URL**（只给 `screenshot_count`）、**不落审计**、只读不写。

**platform-inspection（本域，写侧）**：覆盖「用户输入上传 + 截图上传」的**写能力**。

| 维度 | account-health（读域） | platform-inspection（写域，本域） |
|---|---|---|
| 能力 | 周期列表/当前/概览/单店/历史（读 5） | 模板(R0) + 填写/更新/提交/截图上传/删除（写 4 + 支撑读 1） |
| 数据底座 | inspection_periods / reports / screenshots（同一套） | 同一套，**零新增表/迁移** |
| 项目权限 | 列表过滤语义（handler 内 `project_scope`） | 写路由挂 `require_project_scope`（直取语义 403/404） |
| 审计 | 读不落审计 | 写操作落 `operation_audit_logs`（agent_id 归因） |
| 截图 URL | 不暴露 presigned URL（只给 count） | **不暴露 presigned URL**（给 id + 元数据） |
| 服务层 | 纯读复用 + R2 新增纯读函数 | 写函数直接复用（0 改造），模板常量提取共享 |

**边界规则**：
1. 读巡检数据 → account-health；写巡检数据 → platform-inspection。**调用方组合**（读用 account-health 拿周期/报告现状，写用本域填报），符合单域原则 §1.2.b。
2. **不重复造数据层**：写函数一律复用 `inspection_service`，模板常量提取共享，杜绝两处漂移。
3. **不暴露 presigned URL**：安全口径与 account-health 一致（R2 私桶临时凭证不外泄给 Agent 平台）。
4. 写操作全部落审计（operator=NULL + agent_id + agent_name + idempotency_key 归因，对齐 sku_info `_audit_kwargs`）。

## 4. 决策拍板（D1–D7）

| # | 决策点 | 结论 | 依据 |
|---|---|---|---|
| **D1 域 code** | `platform_inspection` | 与既有 13 域无冲突；`agent_api_keys.business_scope` 字符串列加值无迁移；`KNOWN_BUSINESS_DOMAINS` 加一条 |
| **D2 端点清单** | 写 4 + 支撑读 1（R0 template） | 用户诉求聚焦写路径；读侧已由 account-health 覆盖（边界 §3） |
| **D3 与 account-health 边界** | 读写分离，不重复造数据层，写侧统一挂 project_scope | §3 |
| **D4 数据层** | 复用 `inspection_service` 写函数，0 签名改动；模板常量提取共享 | 避免双份模板/双份写逻辑 |
| **D5 confirm 矩阵** | W1 保存/ W3 上传 **不 confirm**；W2 提交 / W4 删除 **confirm** | 判定标准 = 金钱 / 不可逆状态 / 删除性（§7） |
| **D6 截图 URL** | 上传/删除响应**不暴露 presigned URL**，只给 id + 元数据 | 对齐 account-health 安全口径（D3） |
| **D7 错误码** | **不新增** `INSPECTION_*` 错误码，复用现有 `VALIDATION_FAILED` / `RESOURCE_NOT_FOUND` / `AGENT_PROJECT_OUT_OF_SCOPE` / `CONFIRM_*` | 对齐 account-health 先例（无新增码）；错误细分靠 `details` |

## 5. 端点清单（R0 + W1–W4）

挂载：`agent/__init__.py` 兜底路由之前
`include_router(platform_inspection_router, dependencies=[Depends(require_business_scope("platform_inspection"))])`。

| # | 方法 | 路径 | 能力 | confirm |
|---|---|---|---|---|
| **R0** | GET | `/api/v1/agent/platform-inspection/template` | 巡检表单模板（字段+类型+枚举+阈值 = 写输入 schema） | 否（读） |
| **W1** | PUT | `/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}` | 填写 / 更新报告（upsert 草稿，幂等） | 否 |
| **W2** | POST | `/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/submit` | 提交报告（draft/overdue → submitted，不可逆） | ⚠️ 是 |
| **W3** | POST | `/api/v1/agent/platform-inspection/periods/{period_id}/projects/{project_id}/screenshots` | 上传截图（multipart，压缩 + 缩略图） | 否 |
| **W4** | DELETE | `/api/v1/agent/platform-inspection/screenshots/{screenshot_id}` | 删除截图（R2 对象 + DB 行，不可逆） | ⚠️ 是 |

**路径形态说明**：
- W1/W2/W3 带 `{period_id}/projects/{project_id}` —— 与 account-health 读路由同构（读现状 → 填 → 提交组合自然），且 `project_id` 在路径 → 直接挂 `require_project_scope` 依赖（403 `AGENT_PROJECT_OUT_OF_SCOPE` 直取语义）。
- W4 只有 `screenshot_id` 稳定键 → project 范围在 handler 内校验（`screenshot → report → project_id` 归属，不在凭据范围 → 404/403，对齐 account_health `_project_in_scope` 语义）。
- **不新增 current-period 读路由**：Agent 锚定当前周期用 account-health `R2 /account-health/periods/current`（跨域组合归调用方，D3 边界规则 1）。

## 6. 逐端点字段设计

### 6.1 R0 GET /template

- 复用模板常量（`HEALTH_FIELDS` / `SERVICE_PERFORMANCE_FIELDS` / `SHIPPING_PERFORMANCE_FIELDS` / `COMPLIANCE_FIELDS`），
  目前定义在 `inspections.py` 端点模块——**S2 提取到共享模块**（建议 `app/constants/inspection_template.py` 或 `inspection_service` 内），
  内部端点 + agent 端点同源引用（BEL-93：内部端点改 import、行为不变，regression 锁）。
- 响应（`agent_ok` 壳）：
```json
{ "ok": true, "data": {
  "health_fields": [ { "key": "account_health_rating", "label": "账户健康评级",
                       "label_en": "Account Health Rating", "type": "select",
                       "options": ["Healthy","Good","At Risk","Critical"] } ],
  "service_performance_fields": [ ... 3 项 ... ],
  "shipping_performance_fields": [ ... 4 项 ... ],
  "compliance_fields": [ ... 10 项 ... ] } }
```

### 6.2 W1 PUT …/periods/{period_id}/projects/{project_id}（upsert 草稿）

**请求体**：
```json
{
  "health_data": { "account_health_rating": "Good", "negative_feedback": 2,
                   "late_shipment_rate": 1.5, ... },
  "compliance_data": { "ip_infringement": 0, "listing_policy_violations": 1, ... },
  "status_summary": "本周账户状况良好，无异常"
}
```
- **upsert 语义**：复用 `inspection_service.create_or_update_report`；周期不存在 → 404 `RESOURCE_NOT_FOUND`；项目不在凭据范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`（`require_project_scope` 直取）。
- **显式字段合并（对齐 sku_info W2 读-改-写合并，规避默认值陷阱）**：`health_data` / `compliance_data` 用 pydantic `HealthData` / `ComplianceData` 校验后，**只透传 Agent 显式提供的 key**（`model_fields_set`），未提供的保持当前值（不置 null 覆盖）；`status_summary` 显式提供才更新。缺失整块 → 保持现状。
- **不提供 `screenshot_ids`**（§2.4：service 层 no-op；截图经 W3 上传挂靠 `report_id`）。
- 校验失败（如 `account_health_rating` 非枚举值）→ 400 `VALIDATION_FAILED` + details。
- 审计：`action="platform_inspection.save"`，`target_type="inspection_report"`，`target_id=report.id`，before/after=写侧序列化行，agent 归因。
- 幂等：`Idempotency-Key` 推荐（审计留痕，`no_idempotency` 标记）。
- 响应（写侧序列化，**不含 presigned URL**）：
```json
{ "ok": true, "data": {
  "report_id": 123, "period_id": 9, "project_id": 3, "status": "draft",
  "health_data": {...}, "compliance_data": {...}, "status_summary": "...",
  "screenshot_count": 0, "created_at": "...", "updated_at": "..." },
  "idempotency_key": "..." }
```

### 6.3 W2 POST …/submit（提交，confirm 两步）

- 复用 `inspection_service.submit_report`（report_id 由 period+project 解析）；无草稿 → 404 `RESOURCE_NOT_FOUND`（对齐内部「Report not found. Create a draft first.」）。
- **confirm 预览**：`action="platform_inspection.submit"`，preview 含 `project_id` / `project_name` / `week_start` / `from_status` / `to_status="submitted"` / `health_data` 摘要 / `compliance_total` / `screenshot_count` / 阈值告警 `warnings`（预览阶段即可算，帮助 Agent 向用户说明影响）。
- 执行后：`report.status="submitted"`、`submitted_by=<agent_id>`、`submitted_at`；**响应透出 `warnings`**（阈值告警列表，Agent 可向用户汇报异常指标）。
- 审计：`action="platform_inspection.submit"`，after 含 warnings（对齐内部 submit 的 after_json）。
- ⚠️ 提交后**无回退路径**（内部无 unsubmit）——确认后不可逆（confirm 预览即向用户声明）。

### 6.4 W3 POST …/screenshots（上传，multipart）

- `multipart/form-data`：字段 `file`（图片）。类型 `image/jpeg|png|webp|gif`、大小 ≤10MB（复用 `upload_screenshot` 校验，超限 → 400 `VALIDATION_FAILED` + details）。
- 路径带 period + project → `require_project_scope` 直取；该 (period, project) 无草稿报告 → **404**（先 W1 建档再传图，与前端流程一致：前端先 saveReport 拿 report 再传图）。
- 复用 `inspection_service.upload_screenshot(db, settings, file, report_id, project_slug)`（压缩 + 缩略图 + R2 + 入库，0 改造）。
- 审计：`action="platform_inspection.upload_screenshot"`，`target_type="inspection_screenshot"`。
- 响应：**不暴露 presigned URL**，只给 `screenshot_id` + `filename` / `content_type` / `file_size` / `caption` / `sort_order` / `created_at`。

### 6.5 W4 DELETE /screenshots/{screenshot_id}（删除，confirm 两步）

- 复用 `inspection_service.delete_screenshot`（R2 原图 + 缩略图删除 + DB 行，0 改造）；不存在 → 404 `RESOURCE_NOT_FOUND`。
- **confirm 预览**：`action="platform_inspection.delete_screenshot"`，preview 含 `screenshot_id` / `filename` / 所属 `period_id` / `project_id` / `project_name` / 删除范围（R2 原图 + 缩略图 + DB 行，无恢复）。
- 审计：`action="platform_inspection.delete_screenshot"`。
- 响应：`agent_ok({"deleted": true, "screenshot_id": ...})`。

## 7. confirm 判定矩阵（D5）

对齐 agent-api-design §3.2 原则（**金钱 / 不可逆状态 / 删除性** 才 confirm）：

| 端点 | 是否 confirm | 判定 |
|---|---|---|
| W1 保存/更新草稿 | ❌ 否 | 可逆（可反复 PUT 覆盖）；无金钱；非不可逆状态转换。**是「用户输入上传」的核心自主能力**——confirm 会摧毁 Agent 自主填报工作流，与用户「把这些功能做成 Agent API」诉求冲突 |
| W2 提交 | ⚠️ 是 | **不可逆状态转换**（draft/overdue → submitted，无回退；写 submitted_by/at）——对齐「推进 status（任意 to_status）⚠️（不可逆）」 |
| W3 上传截图 | ❌ 否 | 纯增量**新增**对象（不覆盖旧对象）、可逆（可删）。区别于 sku_info W4 FNSKU 标签（覆盖旧标签 = 删除性才 multipart confirm） |
| W4 删除截图 | ⚠️ 是 | **删除性操作**（R2 对象 + DB 行，无恢复）——对齐「删除货件 DELETE ⚠️（不可逆）」 |

> 补充：W3 虽不 confirm，但仍挂写限流 + 审计 + 文件校验（类型/大小/归属），写动作默认留痕不越权。

## 8. 鉴权 / 限流 / 错误码 / 审计

- **鉴权**：命名空间级 `require_agent_credential`（Bearer + X-Agent-Id）+ `require_agent_read_rate_limit`（agent/__init__.py 默认）；域级 `require_business_scope("platform_inspection")`（装配时挂）。
- **写限流**：W1–W4 挂 `require_agent_write_rate_limit`（120 req/min，对齐 sku_info）。
- **项目权限**：W1/W2/W3 挂 `require_project_scope`（403 `AGENT_PROJECT_OUT_OF_SCOPE` 直取）；W4 handler 内校验归属。
- **错误码**：D7 **不新增**。复用 `VALIDATION_FAILED`(400) / `RESOURCE_NOT_FOUND`(404) / `AGENT_PROJECT_OUT_OF_SCOPE`(403) / `AGENT_BUSINESS_OUT_OF_SCOPE`(403) / `CONFIRM_TOKEN_INVALID`(400) / `CONFIRM_TOKEN_EXPIRED`(409)。文件校验错误用 `VALIDATION_FAILED` + details。
- **审计**：写操作（W1–W4 执行成功那次）落 `operation_audit_logs`，`operator=NULL` + `agent_id` + `agent_name` + `idempotency_key` 归因（对齐 sku_info `_audit_kwargs` 模板）。读 R0 不落审计。

## 9. 服务层缺口与影响面（BEL-93，CodeGraph 核实）

**复用（0 改造）**：`create_or_update_report` / `submit_report` / `upload_screenshot` / `delete_screenshot` / `get_report` / `get_report_by_id` / `get_period`。

**新增（纯增量）**：
1. **模板常量提取共享**：`HEALTH_FIELDS` 等 4 组常量从 `inspections.py` 迁到共享模块（`app/constants/inspection_template.py` 建议），内部端点改 import。影响面：`GET /inspections/template` 行为不变（regression 锁），0 外部调用方。
2. **写侧序列化 helper**（本域模块内）：对齐 account_health `_flatten_row` 拍平口径，但不含 presigned URL；含 `screenshot_count`。
3. **W4 归属解析 helper**（本域模块内）：screenshot → report → project_id → scope 校验（对齐 account_health `_project_in_scope` 语义）。

**接线（纯增量）**：
- `agent/__init__.py`：追加 `include_router(platform_inspection_router, dependencies=[Depends(require_business_scope("platform_inspection"))])`，**必须插在兜底路由之前**。
- `app/api/agent/scope.py` `KNOWN_BUSINESS_DOMAINS`：加 `"platform_inspection"`。
- `agent_api_keys.business_scope`：字符串列加取值，无迁移。

**明确不做**：
- 不改 `inspection_service` 任何函数签名 / 行为。
- 不新增 `INSPECTION_*` 错误码。
- 不暴露 presigned URL。
- 不新增表 / 迁移。

## 10. 测试清单（供 S2 实施）

1. **R0**：模板字段结构完整（health 1 / service 3 / shipping 4 / compliance 10，阈值/枚举齐全）；模板常量提取后内部 `GET /inspections/template` 回归一致。
2. **W1**：周期不存在 404；项目不在凭据范围 403 `AGENT_PROJECT_OUT_OF_SCOPE`；upsert 幂等（重复 PUT 更新同一条不新建，`inspection_reports` 行数不变）；**显式字段合并**（只传 health_data 不重置 compliance_data / status_summary）；`account_health_rating` 非法枚举值 400 `VALIDATION_FAILED`。
3. **W2**：无草稿 404；confirm 两步（预览 → 带 X-Confirm-Token 重放）；重放请求体不一致 → 400 `CONFIRM_TOKEN_INVALID`；提交后 `status=submitted` + `submitted_by=agent_id` + `submitted_at` 非空；响应带 `warnings`（阈值命中时）。
4. **W3**：文件类型 / 大小超限 400；该 (period, project) 无草稿 404；项目不在 scope 403；上传后 R2 对象 + 缩略图 + DB 行；响应**不含 presigned URL**；`sort_order` 递增。
5. **W4**：confirm 两步；删除后 R2 原图 + 缩略图 + DB 行均删除；不存在 404。
6. **壳与错误码**：未鉴权 401 壳；限流 429；业务错误统一壳；FastAPI 422 → `VALIDATION_FAILED` 壳。
7. **路由注册**：`agent/__init__.py` 兜底路由之前注册（不被静默吞成 404 壳）；`KNOWN_BUSINESS_DOMAINS` 含 `platform_inspection`。
8. **回归**：内部 `/api/v1/inspections/*` 9 端点行为不变；account-health 5 条读路由不受影响。

## 11. 阶段规划（BLF-943 S1 → S2/S3）

| 阶段 | issue | 范围 | 产出 |
|---|---|---|---|
| **S1 设计** | BLF-943（本 issue） | 域定位 / 边界 / 端点清单 / confirm 矩阵 / 字段 / 影响面 / 测试清单 | 本文档（v0.1） |
| **S2 实施** | 待建（S1 评审后） | `backend/app/api/v1/endpoints/agent/platform_inspection.py`（R0+W1–W4）+ 模板常量提取 + `KNOWN_BUSINESS_DOMAINS` + 测试（§10） | 5 条路由上线（后端，confirm + 审计 + 写限流） |
| **S3 收尾** | 待建（S2 后） | 前端 `agent-domains.ts` 注册（`platform_inspection`，live，capabilities write）+ `backend/docs/agent-skills/believeboy-platform-inspection.md` skill | Agent 可用 + 调用文档 |

## 12. 风险与开放问题

1. **提交不可逆**：W2 confirm 后无 unsubmit 路径。若未来 Agent 需撤销提交（改错数据），需单独评估（内部也要加 unsubmit + 前端联动）——本域不开口子。
2. **submitted 报告能否再写**：内部端点不校验 report.status（submitted 后仍可 PATCH/传图）。本域**保持内部现状**（不额外加约束）——避免 Agent 无法补充证据；如要锁死在 S2 评审时拍板。
3. **截图 URL 不暴露**：Agent 上传截图后无法在对话里直接展示图片（只有 id + 元数据）。如需展示，用户在前端平台巡检页查看；如确需 Agent 侧展示，后续单独评估短时效 presigned URL（安全评审）。
4. **模板常量提取**：唯一动内部代码的点；S2 用 regression 测试锁 `GET /inspections/template` 行为不变。
5. **W3 传图前置建档**：无草稿报告时 404（对齐前端先保存后传图的流程）；Agent 侧应先 W1 建档再 W3 传图（skill 里写明调用顺序）。

## 版本记录

- v0.1（2026-09-02）：BLF-943 设计规划定稿——域定位 / 读写边界 / 端点 R0+W1–W4 / confirm 矩阵 / 字段设计 / 影响面 / 测试清单 / 阶段规划。
