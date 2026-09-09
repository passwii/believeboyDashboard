# Insight 合同与 Role/Slot 注册表实施计划

> **面向 AI 代理的工作者：** 本计划只冻结合同与注册表；执行层必须按依赖顺序实现每项任务，并在阶段边界运行列出的契约测试，不得迁移旧洞察业务。

**目标：** 冻结新 Insight 的唯一 Pydantic/SSE/Role/slot canonical contract，生成 TypeScript 可消费的 JSON Schema 与 fixtures。

**架构：** 新 Insight 以独立的 run 资源、版本化 Role/slot registry、纯 Pydantic 事件 union 和 transport-independent SSE cursor 为边界。Stage 1 只交付合同、验证器、生命周期规则与生成物；Redis、Celery、FastAPI、业务 adapter 和 UI 在后续阶段接入。

**技术栈：** Python 3、Pydantic v2、`TypeAdapter`/JSON Schema、FastAPI-compatible error mapping、TypeScript generated contract fixtures、pytest/Vitest。

---


## 【需求确认】

冻结新 Insight 的唯一 canonical contract：Pydantic 请求/响应/事件/错误模型、版本化 Role/slot registry、状态机、幂等、重试与 SSE resume 语义，并生成 TypeScript 可消费的 JSON Schema 与 fixtures；旧 `AIInsight`/洞察报告 API、旧表、schedule report 业务链路全部保持不变。

## 方案边界

- 新契约使用独立命名空间 `insight`，不复用旧 `backend/app/schemas/ai_insight.py` 的业务 DTO，也不扩展旧 `AIInsight` 表。
- Stage 1 只交付纯 Pydantic/registry/validator/fixture/JSON Schema。Redis Stream、Celery、FastAPI router、schedule report adapter、前端视觉与实际流生命周期归后续 Issue。
- 公开 `run_id` 使用 UUID4；数据库未来仍遵循仓库 Integer 主键约定，不能把公开 UUID 与旧整数主键混用。
- `schema_version=1` 是当前 wire contract 的固定整型字面量；破坏性字段变更必须升到 2。`role_version` 与 `slot_version` 独立递增。

## 【任务分解】

### I-1：建立公共合同基元与稳定序列化

- **角色：** backend
- **依赖：** 无
- **产出：**
  - `backend/app/services/insight/__init__.py`
  - `backend/app/services/insight/contracts.py`
  - `backend/app/services/insight/limits.py`
  - `backend/app/schemas/insight.py` 中的 `SchemaVersion`、`CountryCode`、`InsightScope`、`InsightRoleRef`、`InsightStatus`、`InsightStage`、`InsightUsage`、`InsightOutput`、`InsightResumeInfo`、`InsightStatusDetail`
- **变更：**
  1. 以 Pydantic v2 `BaseModel`/`TypeAdapter` 定义全部公共类型；已冻结模型统一 `ConfigDict(extra="forbid")`。
  2. `schema_version` 使用 `Literal[1]`，`run_id` 使用 UUID4，`attempt`/`seq` 使用正整数；时间字段必须是带 timezone 的 ISO 8601 datetime。
  3. 固定国家码为 `US|DE|UK`，项目 ID 为正整数；scope 校验由独立 validator 调用既有项目权限服务，不把权限信息写进 schema。
  4. 提供 `serialize_contract(value)`：`model_dump(mode="json", exclude_none=True)` 后使用 `ensure_ascii=False`、稳定 key 排序与固定 separators；fixture 比较解析后的 JSON 与 canonical serialized bytes 两层结果。
  5. 常量集中在 `limits.py`，禁止 endpoint、role、测试各自复制上限。
- **验收标准：**
  - 同一模型同一输入连续序列化结果字节级一致；UUID/date/enum 的 JSON 表示固定。
  - 已知模型出现未知字段时返回 Pydantic `extra_forbidden`，不会静默丢字段。
  - `schema_version != 1`、非 UUID4、naive datetime、非 `US|DE|UK` country、非正 project ID 均被拒绝。
  - `contracts.py` 不 import FastAPI、Redis、Celery、Pydantic AI 或旧 `AIInsight`。

### I-2：定义 InsightRun 请求、run response/detail 与 typed error

- **角色：** backend
- **依赖：** I-1
- **产出：** `backend/app/schemas/insight.py`：
  - `InsightRunRequest`
  - `InsightRunResponse`
  - `InsightRunDetail`
  - `InsightRunActionResponse`
  - `InsightError`
  - `InsightErrorResponse`
  - `InsightErrorCode`
  - `InsightResumeInfo`
- **变更：**
  1. `InsightRunRequest` 固定字段：
     - `schema_version: 1`
     - `role_id: str`
     - `role_version: PositiveInt`
     - `project_id: PositiveInt`
     - `country: CountryCode`
     - `slots: dict[str, JsonValue]`
     - `idempotency_key: str`（ASCII，1–64 字符，正则 `^[A-Za-z0-9._:-]{1,64}$`）
     - `client_request_id: UUID4 | None`
     - `endpoint_id: str | None`、`model_id: str | None`（仅受控标识，正则 `^[a-z0-9][a-z0-9._-]{0,63}$`；禁止 URL、凭据与任意 provider 配置）
  2. 请求模型拒绝 `system_prompt`、`instructions`、`api_key`、`base_url`、`provider_url` 及所有未声明字段；`system_prompt` 单独映射为 `SYSTEM_PROMPT_NOT_ALLOWED`，而非向客户端暴露原始 Pydantic 错误。
  3. `InsightRunResponse` 返回 `run_id`、`attempt`、`role_id`/`role_version`、scope、`status`、固定 `output_format="markdown"`、相对 `detail_url`/`stream_url`/`cancel_url`/`retry_url`、创建/更新时间、`replayed`。不回显 API key、base URL、system prompt 或绝对 provider URL。
  4. `InsightRunDetail` 返回权威状态、stage、progress、当前 attempt、title、`outputs`、usage、artifact_id、错误、时间戳和 `resume` 元信息；`outputs` 使用输出 slot map，首个 role 的规范输出键为 `main`，值为 Markdown artifact（content + lowercase SHA-256 digest）。
     - `resume` 固定为 `{ "latest_event_id": str | None, "current_attempt": PositiveInt, "history_available": bool }`；它只描述 canonical cursor 可恢复性，不暴露 Redis entry、内部 DB key 或 provider 信息。
  5. typed error 固定包含 `code`、用户可展示的 `message`、`retryable`、`retry_after_seconds`、`partial_available`，可选 `field`/`slot`/安全的 `details`。错误 payload 绝不携带异常原文、上游响应、URL、凭据或 system policy。
- **验收标准：**
  - `InsightRunRequest` 的必填字段、大小边界、extra forbid、禁止 prompt/secret 字段均有单测。
  - run response/detail 往返序列化后字段集合和类型不变；`output_format` 不能由客户端覆盖。
  - 每一个 `InsightErrorCode` 都有固定 HTTP 映射、retryable 默认值和前端显示安全说明。

### I-3：实现代码化、版本化 Role/Slot registry

- **角色：** backend
- **依赖：** I-1、I-2
- **产出：**
  - `backend/app/services/insight/roles.py`
  - `backend/app/services/insight/slot_types.py`
  - `backend/tests/insight/test_roles.py`
- **变更：**
  1. `InsightRoleDefinition` 至少包含 `role_id`、`role_version`、canonical key（`{role_id}.v{role_version}`）、`availability`、`required_slots`、`optional_slots`、每个 slot 的 `TypeAdapter`、`output_format`、`default_model_policy`、每 slot/role 的 limits；registry 是单一只读来源。
  2. 激活首个角色 `schedule_report_summary.v1`：
     - 必填 `report.context`
     - 必填 `report.data`
     - 可选 `project.context`
     - 可选 `sku.context`
     - 输出固定为 Markdown，输出键固定为 `main`
     - 默认模型策略标识为 `schedule_report_summary.default`；该标识不是 provider URL，也不包含 secret。
  3. 预注册但不可运行 `ad_analysis.v1`、`inventory_health.v1`，状态为 `reserved`；提交时返回 `ROLE_NOT_AVAILABLE`，与完全未知 role 的 `UNKNOWN_ROLE` 区分。
  4. 所有 slot model 使用 `extra="forbid"`，slot 名称采用小写点分隔命名空间；未来广告/库存只能新增自身 namespace，不得复用 `report.*` 语义。
  5. 首个 role 的 typed slot：
     - `report.context`：`slot_version=1`、frequency（daily/weekly/monthly）、report_date、date_range_start/end、project_ids（1–50）、country、可选 project_name；日期范围必须合法且与 request scope 一致。
     - `report.data`：`slot_version=1`、`encoding="json"`、`payload: object`；payload 允许递归 JSON 值，但受深度、key 数、数组数与字节上限控制，不接受 Python repr、二进制或字符串化 JSON。
     - `project.context`：`slot_version=1`、项目摘要列表，每项至少 project_id/name，最多 50 项。
     - `sku.context`：`slot_version=1`、SKU 摘要列表，每项含 sku，可选 asin/project_id/title/factory_info，最多 200 项。
  6. registry manifest 的 JSON Schema 只暴露角色/slot/version/format/limits；server-side system instruction 只保留在内部实现，不得出现在 manifest、response、fixture 或日志。
- **验收标准：**
  - `schedule_report_summary.v1` 可由 registry 解析并为每个 slot 返回确定的 `TypeAdapter`/JSON Schema。
  - 未知 role、未知 role version、reserved role、未知 slot、缺失 `report.context`/`report.data`、slot extra 字段、slot version 错误都返回对应固定错误码。
  - 请求 project/country 与 `report.context` 不一致时返回 `SCOPE_MISMATCH`，不会继续执行。
  - registry 中不存在任意可由客户端传入的 system prompt 字段。

### I-4：冻结事件 discriminated union、SSE cursor 与状态/attempt 语义

- **角色：** backend
- **依赖：** I-1、I-2、I-3
- **产出：**
  - `backend/app/services/insight/events.py`
  - `backend/app/services/insight/cursor.py`
  - `backend/tests/insight/test_events.py`
  - `backend/tests/fixtures/insight/normal-run.json`
  - `backend/tests/fixtures/insight/failed-run.json`
  - `backend/tests/fixtures/insight/cancelled-run.json`
  - `backend/tests/fixtures/insight/retry-attempt.json`
  - `backend/tests/fixtures/insight/resume-gap.json`
- **变更：**
  1. 定义 `InsightEvent` discriminated union，判别字段为 `type`，事件固定覆盖 `snapshot`、`status`、`content.delta`、`content.snapshot`、`done`、`error`、`ping`；每种事件均继承公共 envelope：`schema_version=1`、`run_id`、`attempt`、`seq`。
  2. `seq` 在每个 attempt 内从 1 开始，严格每事件加 1，不回退、不复用；事件身份为 `(run_id, attempt, seq)`。
  3. 外部 SSE `id` 固定为无空格字符串 `{run_id}:{attempt}:{seq}`，由 `Last-Event-ID` 原样回传；它是 transport-independent canonical cursor，不暴露 Redis entry、provider endpoint 或内部 DB key。transport 可内部保存其他 offset，但不能把内部 offset 直接暴露给前端。
  4. 状态固定为 `queued → aggregating → generating → finalizing → completed|failed|cancelled`，允许从任一非终态直接失败/取消，不允许终态回退或再次终结；重试只允许 failed/cancelled。
  5. 正常 attempt 的规范顺序为：初始 `snapshot`（当前状态）、状态事件、零个或多个 `content.delta`、可选 `content.snapshot` checkpoint、`finalizing`、`completed`、唯一 `done`。失败/取消以唯一 `error` 结束，错误 code 分别使用业务失败码或 `CANCELLED`；终态后不得再发内容/状态事件。
  6. `snapshot` 是完整当前状态 checkpoint，包含 status/stage/progress/outputs、`is_terminal` 与安全 error 摘要；无 Last-Event-ID 或历史窗口缺口时可重复发送同一 checkpoint ID。`content.snapshot` 只覆盖一个输出 slot，用于内容恢复，不改变状态机。
  7. `content.delta` 固定包含 output `slot`、`block_id`、`format="markdown"`、非空 delta；`done` 包含 final outputs、artifact_id、title、digest、usage、attempt；`error` 使用 `InsightError`；`status.detail` 只能是最多 512 字符的安全展示文本；`ping` 只有公共 envelope，不改变业务状态。
  9. retry 保留同一 `run_id`、attempt 加 1、seq 重置为 1；旧 attempt 的事件不能混入新 attempt，旧 worker 发出的低 attempt 事件必须被 sink/状态机拒绝。Last-Event-ID 同 attempt 时从 `seq+1` 开始；旧 attempt cursor 遇到新 attempt 时发送当前 attempt snapshot；非法/未来 cursor 返回 `RESUME_CURSOR_INVALID`。
- **验收标准：**
  - TypeAdapter 能按 `type` 正确解析七类事件；缺少公共 envelope、错误 discriminator、错误嵌套 slot、未知字段均有明确失败断言。
  - normal/failed/cancelled/retry/resume fixtures 的 `seq`、attempt、SSE id、状态转换、终态唯一性可由通用测试遍历验证。
  - 重放同一 event JSON 得到相同模型和 canonical bytes；同一 `(run_id,attempt,seq)` 不允许代表两个不同事件。
  - fixture 不含 API key、authorization、base_url/provider_url、绝对 endpoint、system_prompt/system secret；只允许相对本产品 URL 与受控 `endpoint_id/model_id`。

### I-5：实现请求验证、状态机与幂等规则的纯服务层

- **角色：** backend
- **依赖：** I-2、I-3、I-4
- **产出：**
  - `backend/app/services/insight/validator.py`
  - `backend/app/services/insight/lifecycle.py`
  - `backend/tests/insight/test_validation.py`
  - `backend/tests/insight/test_lifecycle.py`
- **变更：**
  1. `validate_run_request(request, registry, scope_authorizer)` 按固定顺序校验：schema/base fields → role/version/availability → top-level secret/prompt keys → scope/project-country → slot names/requiredness → per-slot Pydantic → per-slot/aggregate/body limits → controlled model identifiers → canonical fingerprint。
  2. 固定 limits：请求 JSON body ≤ 1 MiB；单 slot canonical JSON ≤ 256 KiB；全部 slots 合计 ≤ 768 KiB；字符串 ≤ 16 KiB；对象 key ≤ 64 字符且每对象最多 100 个 key；数组最多 500 项；嵌套深度最多 8；超限分别返回 `REQUEST_TOO_LARGE`、`SLOT_TOO_LARGE` 或 `SLOT_VALIDATION_FAILED`，不得截断后继续运行。
  3. 计算幂等 fingerprint 时纳入 schema_version、role/version、project/country、slots 的 canonical JSON、endpoint_id/model_id；排除 idempotency_key 与 client_request_id。相同 key + 相同 fingerprint 命中同一 run/attempt 并标 `replayed=true`；相同 key + 不同 fingerprint 返回 `IDEMPOTENCY_KEY_CONFLICT`。
  4. lifecycle 提供合法转换表和终态判定；completed/failed/cancelled 都是终态；每个 attempt 最多一个 terminal `done|error`；cancel/retry 重复调用均为幂等或固定 409，不创建隐藏 attempt。
  5. scope authorizer 对 create/detail/events/cancel/retry 使用同一权限入口；项目存在但不在调用者范围时返回 `PROJECT_OUT_OF_SCOPE`，已通过访问校验但 country 与项目不匹配时返回 `COUNTRY_MISMATCH`；不把跨项目内容写入错误 details。
- **验收标准：**
  - 每个边界值都有正反用例：limit 通过、limit+1 拒绝；空/空白/65 字符幂等 key 拒绝；同 key 相同/不同 payload 行为稳定。
  - 生命周期测试覆盖合法路径、跳过中间阶段、终态回退、终态重复、旧 attempt 事件、cancel 与 retry 竞争。
  - validator 纯函数不触发 LLM、Redis、Celery、DB 写入；scope 通过注入的 authorizer 模拟，便于后续 endpoint 复用。

### I-6：导出 TypeScript 对齐 Schema 与契约 fixtures

- **角色：** backend + frontend
- **依赖：** I-2、I-3、I-4、I-5
- **产出：**
  - `backend/scripts/export_insight_contract.py`
  - `frontend/types/api-generated/insight-contract.json`
  - `frontend/types/api-generated/insight-fixtures/normal-run.json`
  - `frontend/types/api-generated/insight-fixtures/failed-run.json`
  - `frontend/types/api-generated/insight-fixtures/cancelled-run.json`
  - `frontend/types/api-generated/insight-fixtures/retry-attempt.json`
  - `frontend/types/api-generated/insight-fixtures/resume-gap.json`
  - `frontend/lib/insight/contract-fixture.test.ts`（仅验证 fixture/union 对齐，不实现 UI）
  - `InsightRunActionResponse` 的前端 fixture（cancel/retry）
- **变更：**
  1. exporter 聚合 request/response/detail/error/event TypeAdapter JSON Schema 与 role manifest，固定排序、固定 `schema_version`，支持 `--check` 检查工作树中的 generated artifact 无漂移。
  2. 前端 fixture 与 backend fixture 使用同一 canonical JSON 内容；不得手工维护第二套字段名或错误码表。
  4. 前端只依赖相对 stream/detail/action URL、role metadata、output format、typed error；不得读取 Redis/DB，不得接触 endpoint URL/API key/system prompt。
- **验收标准：**
  - exporter `--check` 在无改动时通过，修改 Pydantic schema 未重新生成时失败并指出 drift。
  - TypeScript fixture test 能验证 normal/retry/resume 的 `seq`/attempt/id 规则，未知事件/坏 JSON不导致测试 runner 崩溃。
  - 本任务不修改旧 `frontend/lib/api/ai-chat-stream-v2.ts`、旧洞察页或旧报告 UI。

### I-7：冻结合同回归矩阵并交接 Stage 2

- **角色：** backend + frontend
- **依赖：** I-1 至 I-6
- **产出：**
  - `backend/tests/insight/test_contract.py`
  - `backend/tests/insight/test_fixture_redaction.py`
  - `frontend/lib/insight/contract-fixture.test.ts` 的最终回归断言
  - 完成评论中的 schema 路径、fixture 路径、消费约束与非目标说明
- **变更：**
  1. contract test 覆盖稳定序列化、requiredness、discriminated union、未知 event、role/version、slot、scope、limits、idempotency、state machine、terminal uniqueness、resume cursor、retry attempt、secret redaction。
  2. 测试命令只跑契约集，不触发全量后端业务测试、Redis、Celery、远程 provider 或数据库写入。
  3. 在完成评论明确 Stage 2 消费入口：生成 `frontend/types/api-generated/insight-contract.json`；事件公共 envelope 与 `id={run_id}:{attempt}:{seq}`；Last-Event-ID 续传；未知 event ignore；terminal/partial/retry 处理；客户端不能提交 system prompt 或 provider secret。
- **验收标准：**
  - contract test 全绿，且每项任务描述的错误码、边界与 fixture 都有可观察断言。
  - 旧 `AIInsight` schema/model/endpoint/test 没有被修改；CodeGraph 影响面确认只新增 Insight contract 使用点。
  - 完成评论发布冻结后的 schema/registry/fixture 路径，供 Stage 2 后端 transport 与前端 stream client 直接消费。

## 【接口契约】

### 1. 资源与 HTTP 方法

Stage 1 只冻结 schema 与 fixture，不挂载 router；以下路径是 Stage 2 的唯一实现目标：

| 方法 | 路径 | 成功 | 语义 |
|---|---|---:|---|
| POST | `/api/v1/insights/runs` | 202 | 创建 run；同幂等 key + 同 fingerprint 返回同一 run，`replayed=true` |
| GET | `/api/v1/insights/runs/{run_id}` | 200 | 权威 detail；页面重开、SSE 过期、后台完成后均可读取 |
| GET | `/api/v1/insights/runs/{run_id}/events` | 200 | `text/event-stream`；可选 `Last-Event-ID`，从下一 canonical cursor 续传 |
| POST | `/api/v1/insights/runs/{run_id}/cancel` | 200/409 | 取消当前非终态 attempt；重复取消幂等，终态完成返回 `RUN_TERMINAL` |
| POST | `/api/v1/insights/runs/{run_id}/retry` | 202/409 | 仅 failed/cancelled 可重试；同一 run_id，attempt+1，seq 从 1 重启 |

### 2. InsightRunRequest

```json
{
  "schema_version": 1,
  "role_id": "schedule_report_summary",
  "role_version": 1,
  "project_id": 42,
  "country": "US",
  "slots": {
    "report.context": {
      "slot_version": 1,
      "frequency": "weekly",
      "report_date": "2026-09-09",
      "date_range_start": "2026-09-01",
      "date_range_end": "2026-09-07",
      "project_ids": [42],
      "country": "US",
      "project_name": "Demo"
    },
    "report.data": {
      "slot_version": 1,
      "encoding": "json",
      "payload": {"current_week": {"qty": 12}, "changes": {"qty_pct": -0.1}}
    }
  },
  "idempotency_key": "schedule-20260909-42-weekly-1",
  "client_request_id": "9f3ef6b5-9b9e-4e77-96cf-9f88a5a3c6a7",
  "endpoint_id": "default",
  "model_id": null
}
```

- `role_id + role_version` 的 canonical display key 为 `schedule_report_summary.v1`。
- `slots` 是命名空间 map，不允许未注册 slot；每个值由 registry 绑定的 Pydantic `TypeAdapter` 校验。
- 客户端永远不能提交 `system_prompt`、provider URL、API key、Authorization header 内容或任意 model policy。
- `endpoint_id`/`model_id` 仅可为 server-side allowlist 标识；Stage 1 不验证 provider 可用性，Stage 1-B 负责 resolver。

### 3. InsightRunResponse

```json
{
  "schema_version": 1,
  "run_id": "0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7",
  "attempt": 1,
  "role_id": "schedule_report_summary",
  "role_version": 1,
  "project_id": 42,
  "country": "US",
  "status": "queued",
  "output_format": "markdown",
  "detail_url": "/api/v1/insights/runs/0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7",
  "stream_url": "/api/v1/insights/runs/0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7/events",
  "cancel_url": "/api/v1/insights/runs/0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7/cancel",
  "retry_url": "/api/v1/insights/runs/0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7/retry",
  "replayed": false,
  "created_at": "2026-09-09T08:00:00Z",
  "updated_at": "2026-09-09T08:00:00Z"
}
```

URL 只允许相对本产品路径；禁止把 provider base URL、API key、system prompt 或内部异常放入 response。

### 4. InsightRunDetail

```json
{
  "schema_version": 1,
  "run_id": "0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7",
  "attempt": 1,
  "role_id": "schedule_report_summary",
  "role_version": 1,
  "project_id": 42,
  "country": "US",
  "status": "completed",
  "stage": "finalizing",
  "progress_percent": 100,
  "output_format": "markdown",
  "outputs": {
    "main": {
      "format": "markdown",
      "content": "## 本周摘要\n\n- ...",
      "content_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  },
  "artifact_id": "artifact-opaque-id",
  "usage": {"input_tokens": 100, "output_tokens": 80, "total_tokens": 180},
  "error": null,
  "resume": {"latest_event_id": "0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7:1:12", "current_attempt": 1, "history_available": true},
  "created_at": "2026-09-09T08:00:00Z",
  "started_at": "2026-09-09T08:00:01Z",
  "completed_at": "2026-09-09T08:00:12Z",
  "updated_at": "2026-09-09T08:00:12Z"
}
```

`stage` 在终态 detail 中保留最后一个执行阶段；前端以 `status` 决定生命周期，以 `stage` 作为展示细节。`outputs` 是权威最终内容，SSE draft 不是永久存储。

### 5. SSE envelope 与事件 payload

每一帧固定为：

```text
id: {run_id}:{attempt}:{seq}
data: {canonical-json}

```

事件公共字段：

```json
{
  "schema_version": 1,
  "run_id": "0f9d7ed1-c8cf-4c11-b3ae-5d1453e4f7b7",
  "attempt": 1,
  "seq": 4,
  "type": "content.delta"
}
```

事件字段冻结如下：

| `type` | 必填业务字段 | 语义 |
|---|---|---|
| `snapshot` | `status`, `stage`, `progress_percent`, `outputs`, `is_terminal`, `error` | 当前 run/attempt 全量 checkpoint；无 cursor 或 history gap 时可发送；重复 checkpoint ID 不视为新内容 |
| `status` | `status`, `stage`, `progress_percent`, `detail: string | null` | 任一状态/stage/progress 变化；detail 仅用于安全展示，不携带 prompt 或 secret |
| `content.delta` | `slot`, `block_id`, `format="markdown"`, `delta` | 真实生成增量；客户端按 slot/block_id 累积，不逐字符人为重放 |
| `content.snapshot` | `slot`, `format="markdown"`, `content`, `content_sha256`, `checkpoint_seq` | 单输出 slot 的完整 checkpoint；替换该 slot draft，避免 history gap 丢文本 |
| `done` | `status="completed"`, `outputs`, `artifact_id`, `title`, `content_sha256`, `usage` | 唯一成功终态事件；detail 仍是最终权威来源 |
| `error` | `status="failed"|"cancelled"`, `error` | 唯一失败/取消终态事件；取消使用 `error.code="CANCELLED"` |
| `ping` | 无额外业务字段 | keepalive；不改变 UI 状态，仍带 seq/id |

### 6. Typed error codes 与 HTTP 映射

| code | HTTP | 默认 retryable | 触发条件 |
|---|---:|---:|---|
| `INVALID_REQUEST` | 422 | false | 基础字段/日期/JSON 结构不合法 |
| `UNKNOWN_ROLE` | 422 | false | role_id 未注册 |
| `ROLE_VERSION_UNSUPPORTED` | 422 | false | role 已知但 version 未注册 |
| `ROLE_NOT_AVAILABLE` | 422 | false | 预留 role 尚未启用 |
| `UNKNOWN_SLOT` | 422 | false | slot namespace 不在 role manifest |
| `MISSING_REQUIRED_SLOT` | 422 | false | 缺失 role 必填 slot |
| `SLOT_VALIDATION_FAILED` | 422 | false | slot Pydantic/type/semantic 校验失败 |
| `SCOPE_MISMATCH` | 422 | false | slot 内 `report.context` 与请求 project/country 不一致 |
| `PROJECT_NOT_FOUND` | 404 | false | project 不存在 |
| `PROJECT_OUT_OF_SCOPE` | 403 | false | 调用者无 project 访问权 |
| `COUNTRY_MISMATCH` | 422 | false | 已通过权限校验的项目实际 country 与请求 country 不一致 |
| `REQUEST_TOO_LARGE` | 413 | false | body 超过 1 MiB |
| `SLOT_TOO_LARGE` | 413 | false | slot 或 aggregate slots 超限 |
| `SYSTEM_PROMPT_NOT_ALLOWED` | 422 | false | 请求尝试提交 system prompt/instructions |
| `IDEMPOTENCY_KEY_REQUIRED` | 422 | false | 缺失/空白/格式非法 key |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | false | 同 key 对应不同 fingerprint |
| `RUN_NOT_FOUND` | 404 | false | run_id 不存在或无权访问时按安全策略隐藏 |
| `RUN_TERMINAL` | 409 | false | 对 completed run cancel/retry 或重复终结 |
| `INVALID_STATE_TRANSITION` | 409 | false | 非法状态回退/跨 attempt 事件 |
| `RESUME_CURSOR_INVALID` | 400 | false | Last-Event-ID 格式错误或指向未来 attempt |
| `MODEL_NOT_ALLOWED` | 422 | false | model/endpoint 标识不在 server allowlist |
| `RATE_LIMITED` | 429 | true | Insight 运行限流 |
| `PROVIDER_UNAVAILABLE` | 503 | true | provider 未配置/不可用 |
| `UPSTREAM_TIMEOUT` | 504 | true | 上游超时 |
| `CONTENT_FILTERED` | 422 | false | 上游内容安全拒绝 |
| `CANCELLED` | 409 | false | 当前 attempt 已被显式取消；仅作为 SSE `error` 事件的 typed code |

所有 `InsightErrorCode` 的 wire value 固定为表中大写字符串；Python enum member 与 TypeScript union 必须保持同名同值。

- start 的 `idempotency_key` 必填；fingerprint 不包含 key 本身。相同 key + 相同 canonical request 永远指向同一 `run_id`，不会重复发起 LLM；相同 key + 不同 request 返回 409。
- retry 保留 `run_id`，产生 `attempt=n+1`；attempt 内 seq 从 1 重新计数。旧 attempt 事件、旧 worker 迟到事件不得覆盖新 attempt。
- cancel 对 queued/aggregating/generating/finalizing 有效；重复 cancel 返回当前 cancelled 状态，不产生第二个 error/attempt；completed/failed 后按 `RUN_TERMINAL` 返回 409。
- Last-Event-ID 使用 `{run_id}:{attempt}:{seq}`。同 attempt 从 `seq+1` 继续；cursor 属于旧 attempt 时返回最新 attempt snapshot；历史缺口用全量 `snapshot` 恢复；未来 attempt/坏格式返回 `RESUME_CURSOR_INVALID`。
- 每个 attempt 恰好 0 或 1 个 terminal event，运行结束后只能是 1 个；`done` 与 `error` 互斥。`status` 终态事件不是 terminal event，不可替代 `done/error`。

## 【风险标注】

1. **需人工确认：retry 是否复用 run_id。** 本计划选择同一 run_id + attempt 递增，便于 detail URL、权限和前端恢复稳定；若产品要求每次 retry 都是新资源，必须在实现前改为新 UUID，否则会影响幂等、fixture 与 Stage 2 hook。
2. **需人工确认：SSE 外部 id 是否采用 transport-independent cursor。** 本计划选择 `{run_id}:{attempt}:{seq}`，避免把 Redis entry id 泄露为公共协议；如果 Stage 2 强制要求原始 Redis ID，需同时冻结跨 attempt 拼接与 history-gap 语义，不能临时替换。
3. **需人工确认：首个 schedule role 的 `report.data` 粒度。** daily/weekly/monthly 当前 payload 结构不同，本计划选择版本化 JSON envelope，避免把旧 report builder 字段写死进基础设施；Stage 4 adapter 仍需为业务 payload 保持稳定的 `slot_version` 与 golden fixture。
4. **需人工确认：scope 国家集合。** 本计划按当前项目约定冻结 `US|DE|UK`；若业务需要 CA/JP/FR 等站点，应在合同冻结前扩展 `CountryCode` 与权限/金额口径，不能由客户端自由传任意字符串。
5. **需人工确认：payload 上限。** 当前硬上限为 body 1 MiB、单 slot 256 KiB、slots 合计 768 KiB；若真实周/月报超过上限，Stage 4 应改用后端 subject/reference slot，而不是静默放宽或截断数据。
6. **无需确认且必须落实：** 不改旧 AIInsight 任何表/endpoint；不将 API key、provider URL、system prompt、内部异常写入 schema、event、fixture、日志或 response；不在本 Issue 引入 Redis/Celery/业务迁移。
