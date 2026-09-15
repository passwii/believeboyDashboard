# Insight 观测期质量 / 成本门禁（BLF-1018 · Stage 5）

> **状态：** 观测期已上线，legacy 退役**尚未执行**（等门禁三票齐备 + 人工拍板）
> **负责人：** Damon（后端工程师）· 合并把关：代码质量工程师 Tia
> **关联：** BLF-1018（Stage 5）· BLF-1005（父）· BLF-1017（Stage 4 前端，Seth）
> **迁移：** `20260912_271_insight_run_observations.py`（新增观测表，只增不改）

一句话：**先拿证据，再退役。** canonical Insight 链路（`/api/v1/insight/runs`）跑一段时间，
由观测表落账、门禁脚本出裁决；在「指标达标 + 调用方清零 + 回滚演练通过」三票齐备前，
legacy `/ai-insights` 写端点、旧 URL、历史表**一律不删**。

---

## 一、观测到什么，锚点在哪

一次 run 的观测行落在 `insight_run_observations`（模型
`backend/app/models/insight_run_observation.py`，迁移 `backend/alembic/versions/20260912_271_insight_run_observations.py`）。

数据分两段：

| 阶段 | 载体 | 说明 |
|------|------|------|
| 运行中 | Redis hash `bb:insight:metrics:{run_id}` | 计数器（帧数/字节/重连/取消/首字时延），随 run 生命周期存活 |
| 终态 | DB 行（唯一键 `run_id`） | **审计记录**：Redis 过期/抽风都不影响它 |

关键字段与它们的锚点（阈值不是拍脑袋，全部对齐仓库里已有的硬数字）：

| 字段 | 含义 | 锚点 / 为什么是这个口径 |
| ------ | ------ | ------------------------ |
| `first_delta_ms` | attempt 起点 → 首帧 `content.delta` | BLF-1071 起执行器**真流式**：每个 provider token delta 就是一帧，所以这个值就是**真首字时延**（不再是整段产出时延）；重投时不覆盖（`set_metric_if_absent`） |
| `duration_ms` | attempt 起点 → 终态 | 由 `runs.py:try_transition` 在终态写入 |
| `input/output/total_tokens` | LLM 用量 | 执行器终态写入的 `usage_json` |
| `attempts` / `retries` | 尝试次数 / 重试次数 | `attempts = attempt`，`retries = attempt - 1` |
| `stream_opens` / `stream_reconnects` | SSE 连接次数 / 其中带游标的恢复次数 | 连接即 +1；`Last-Event-ID` 非空即计一次重连（`insight_runs.py` SSE handler） |
| `reconnect_completed` | 重连后确实补到终态帧 | `stream_reconnects` 的闭环判据：只数「重连且拿到 `done/error`」的次数，光重连不算（同一个 SSE handler 记点） |
| `stream_frames` / `stream_bytes` / `stream_xlen` / `stream_memory_bytes` | 传输量 / 保留窗口水位 | `stream_frames`、`stream_bytes` 由 `append_event` 顺手 `hincrby`；`stream_xlen`、`stream_memory_bytes` 走 `XLEN` / `MEMORY USAGE`。**BLF-1071 后 `stream_frames` 数量级上升**（每 token 一帧，见 §四） |
| `cancel_requested` / `cancel_succeeded` | 取消请求数 / 真正落地数 | **同一个 run 里两者不等 = 取消失败**（`cancel_not_landed` 门禁项） |
| `error_code` / `error_retryable` | 错误类型 | **只落错误码**，不落上游报文（见 §三） |
| `fallback` / `fallback_reason` | 降级事件与原因 | 旧链路降级时打点，按 capability 分桶 |
| `capability` | 归属桶 | canonical 是 `insight`；legacy 降级是 `ai_summary` |

写观测行是**旁路**：所有写入 `try/except` 吞异常 + 打 warning。**记录失败绝不能让 run 或取消失败。**
唯一例外是终态行本身：读 Redis 指标的那一步单独兜了异常 —— 丢指标可以，丢审计行不行
（`finalize_run_observation`）。

### 敏感信息红线（验收 §1）

- `observation.py` 的 `FORBIDDEN_SOURCES` = `system_prompt / instructions / api_key / base_url / provider_url / slots / slots_json`；
- 观测行**没有**任何承载 prompt、slot 原文、密钥的列 —— 测试用「列白名单」断言把这条钉死
  （`tests/insight/test_observation.py`：新增列必须显式进白名单，否则测试挂）；
- 日志侧同样断言：脱敏矩阵测试把密钥/系统提示/原始 slot 塞进 run 与 Redis，再检查
  DB 行、`caplog` 记录、Redis metric hash 三处都不出现这些字符串。

---

## 二、门禁怎么判

### 2.1 阈值（`Settings`，`backend/app/core/config.py`）

| 配置 | 默认 | 锚点 |
| ------ | ------ | ------ |
| `insight_observation_enabled` | `True` | 观测总开关（关掉则不落账） |
| `insight_observation_window_days` | `7` | 聚合窗口 |
| `insight_gate_max_duration_ms` | `300_000` | = Celery `soft_time_limit=300s` |
| `insight_gate_max_first_delta_ms` | `90_000` | = `ai_chat_timeout_seconds` |
| `insight_gate_max_stream_frames` | `10_000` | = `insight_stream_maxlen`（保留窗口上限） |
| `insight_gate_max_fallback_ratio` | `0.0` | **`0` = 不判定**（不是「必须为 0」） |
| `insight_gate_cost_anomaly_multiplier` | `5.0` | 运维经验值，非仓库固定数字（唯一一个） |
| `insight_semaphore_wait_seconds` | `60` | 单次 run 等并发闸门的上限 |

约定：**任何阈值为 `0` 表示「不判定 / 只上报」** —— 时长、首字时延、流保留窗口、降级比例
四把尺子同一条规则（降级比例默认 `0.0`，故默认只报数）。配了正阈值后：时长、首字时延、
降级比例、取消未落地、成本异常会升级为 `blocking`；失败数、重试数只报 `info`。
配置里的 `0` 只此一义：想表达「不允许降级」请配一个正的下限（如 `0.0001`）。

### 2.2 分桶与并发 / 成本上限

canonical 与 legacy **物理分桶**，互不顶占（`app/services/insight_concurrency.py` 的
`bucket_caps()` 是唯一事实源，采集路径与报告读同一份）：

| 桶 | 上限 | 谁在用 |
|----|------|--------|
| `insights` | `max_concurrent_insights`（3） | canonical run（本阶段新增闸门）+ legacy `generate.py` |
| `ai_summary` | `max_concurrent_ai_summary`（5） | 旧 AI 摘要 |

canonical 路径此前**没有**并发闸门，本阶段补上（`celery_tasks/insights/run.py`）：

- 抢到 → 正常执行；
- 桶饱和（`False`）→ **不调用 LLM**，任务重排队（run 保持 `queued`，attempt 不变）；
  重试耗尽才 park 成 `RATE_LIMITED` 失败；
- Redis 传输不可用（`None`）→ **放行**（fail-open）。这条链路的首要目标是「run 不丢」，
  观测/闸门不该因为 Redis 抖动变成新的故障源。

### 2.3 只看 canonical 桶的结论

`is_retirement_eligible()` 只对 `CANONICAL_CAPABILITIES = ("insight",)` 判定 ——
`ai_summary` 桶本身就是待退役对象，它的降级不该挡住新链路结论。

**空窗口 = 不达标**：窗口内没有样本时返回
`insufficient_data:insight.runs=0`。没数据的「通过」等于把退役批准建立在没有证据之上。

**指标票只有一个口径**：`GateReport.eligible_for_retirement` / `retirement_reasons`
是唯一事实源，`as_dict()`（HTTP 响应与审计脚本共用的 JSON）、`is_retirement_eligible()`
（脚本退出码）都从它取数，三处不可能分叉。`as_dict()['blocking_count']` 因此等于
`len(retirement_reasons)`（0 ⇔ 指标票通过）；legacy 桶的 blocking 结论仍完整留在
`findings` 里供审计，但不进退役口径。

### 2.4 查询与出报告

只读端点（**仅管理员**，`X-Is-Admin`；聚合是跨项目的，做成 per-project 会给出「假达标」）：

| 端点 | 用途 |
|------|------|
| `GET /api/v1/insight/observation/gate?window_days=7&capability=insight` | 完整门禁报告（桶 + findings + 阈值） |
| `GET /api/v1/insight/observation/retirement-readiness` | 三票就绪度；`eligible` 恒为 `False`，第三票由脚本采集，API 不替它下结论 |

命令行出报告（CI / VPS 可复现，**只读**，不写库不动开关）：

```bash
cd backend && python scripts/insight_gate.py            # 退出码 0=过 / 1=不过 / 2=环境不可用
cd backend && python scripts/insight_gate.py --json /tmp/insight-gate.json
```

脚本输出：阈值表 → 各桶指标与 findings → 分桶上限 → **逐 target 的退役判定（含外部调用方清单）**
→ CodeGraph 证据 → 场景矩阵 → 切换时间窗/回滚 → 门禁结论。

### 2.5 质量门禁场景（验收 §2）

`backend/tests/insight/test_quality_gate_scenarios.py` 把每类故障跑成**结构化裁决**
（`{scenario, status, observed, checks}`，每条 check 带 `value`/`expected`），
`all_scenarios()` 同时被 pytest 与门禁脚本消费，**发布的证据不可能与测过的漂移**：

| 场景 | 断言的核心事实 |
| ------ | ---------------- |
| `success` | 正常跑完：首字时延/时长/token/帧数落库，桶 error_rate = 0 |
| `failure` | provider 不可用 → run FAILED，**只记错误码**（不记上游报文） |
| `cancel` | 用户取消 → cancelled，取消成功率 1.0（请求真的落地） |
| `retry` | 传输级重投不改 attempt；用户级 retry 换代，两次执行各留账，重试**不阻断**退役 |
| `reconnect` | 带游标重连只补未见的帧，无重复，终止帧恰好一次 |
| `permission_escalation` | 冻结后的域走旧写入口 → 409；观测端点非管理员 → 403 |
| `cost_anomaly` | 单 run token 超桶内中位数 × multiplier → blocking，退役被拦 |
| `rollback_drill` | 清空开关 → legacy 写恢复、canonical 域 409（回滚演练） |

HTTP 层的对应验证在 `tests/api/test_insight_domain_runs.py`（冻结 409）与
`tests/api/test_insight_observation.py`（非管理员 403），场景套件不重复铺 HTTP 管道。

---

## 三、可观测性的两条边界（必须随证据一起读）

1. **首字时延的锚点在 `open()` / 首个 `on_status` 补齐**。任务在 `execute_run` **之前**
   就 open sink，那一刻 run 还是 `queued`（`started_at` 为空）；锚点只能等第一次 phase
   checkpoint（`started_at` 由 `try_transition` 首次盖上）。这个洞是被 `success` 场景抓出来的
   （观测行 `first_delta_recorded: false`），已在 `sink.py` 修掉：`open()` 拿到行就取，
   没有就在首个 `on_status` 补，两处都做 naive → aware UTC 归一。
2. **静态调用图看不见 `.delay()`**。`generate_insight` 的生产派发是 Celery 动态派发，
   CodeGraph 报 "No callers found" 是**预期**结果，不是漏查。因此「调用方清零」的定义是：
   **静态扫描 0 个未知调用方 + 全部派发点都在退役集合内**（见 §4）。HTTP 调用方在浏览器里，
   不构成阻塞项。

---

## 四、删除清单（退役时按此执行；**本阶段一律不删**）

### 4.1 可退役面：legacy `/ai-insights` 写端点 + 调度扇出（capability `insight`）

canonical 替代者：`POST /api/v1/insight/runs`（+ 域端点
`/api/v1/insight/ad-analysis/runs`、`/api/v1/insight/inventory-health/runs`）。

**写入口（HTTP）—— `backend/app/api/v1/endpoints/ai_insight.py`**

| 行 | 端点 | 说明 |
| ---- | ------ | ------ |
| `:141` | `POST /generate` | 建行 + `celery_generate_insight.delay`（`:180`） |
| `:439` | `POST /schedules` | 建调度 |
| `:464` | `PATCH /schedules/{id}` | 改调度 |
| `:482` | `DELETE /schedules/{id}` | 删调度 |
| `:499` | `POST /schedules/{id}/toggle` | 启停调度 |
| `:523` | `POST /schedules/{id}/run-now` | 立即跑（内含 `:662` 派发） |
| `:595` | `PUT /{insight_id}` | 改在途 run |
| `:624` | `POST /{insight_id}/retry` | 重试（内含 `:662` 派发） |
| `:667` | `DELETE /{insight_id}` | 删 run |

**派发点（Celery / 服务层）**

| 位置 | 内容 |
| ------ | ------ |
| `backend/app/api/v1/endpoints/ai_insight.py:180` | `celery_generate_insight.delay(None, insight_id=...)` |
| `backend/app/api/v1/endpoints/ai_insight.py:662` | 同上（retry / run-now） |
| `backend/app/services/insight_schedule_service.py:22` | `from ...generate import generate_insight` |
| `backend/app/services/insight_schedule_service.py:450` | `generate_insight.delay(schedule_id)`（定时扇出） |
| `backend/app/services/insight_schedule_service.py:483` | `generate_insight.delay(schedule_id, insight_id=...)` |

**直连 LLM 的 legacy 执行器**

| 位置 | 内容 |
|------|------|
| `backend/app/celery_tasks/insights/generate.py:160` | `run_insight_generation(...)`（旧执行器入口） |
| `backend/app/services/ai_insight_runtime_service.py:39` | `run_insight_generation()` —— 旧直连 LLM 运行时 |

**登记表联动**：`backend/app/services/infra/cache_write_endpoints.py:571` 起是 L2 `ai_insight`
写端点登记（BLF-669），同批删除。

**前端 legacy 面（BLF-1017 / Seth，不在本 PR 范围）**

| 位置 | 内容 |
| ------ | ------ |
| `frontend/app/dashboard/ai/insights/page.tsx:1717,1781,1909,1953,1996,2271,2305,2331,3227,3232` | 旧列表/详情/SSE/重试/编辑/生成/调度写调用（`/api/backend/v1/ai-insights*`） |
| `frontend/app/dashboard/ai/insights/page.tsx:2234` | **旧轮询**：`setInterval(loadInsights, 10_000)`（canonical 是 SSE，不再轮询） |
| `frontend/app/dashboard/ai/ad-analysis/page.tsx:41,255,260` | 复用旧调度组件 / 旧调度写调用 |
| `frontend/components/dashboard/ai-insights/{schedule-dialog,schedule-list}.tsx` | 旧调度 UI |
| `frontend/lib/api/ai-insight-schedules.ts:195,201,213,222,229,236` | 旧调度前端封装 |
| canonical 侧已就位 | `frontend/lib/insight/client.ts`、`frontend/hooks/use-insight-stream.ts` |

### 4.2 本阶段**不退役**：旧 AI 摘要写入（capability `ai_summary`）

canonical 链路尚未承接这三个业务面，冻结会直接打断定时报表 / 库存台账摘要
（非目标：不改变未迁移业务的降级行为）：

| 位置 | 内容 |
| ------ | ------ |
| `backend/app/api/v1/endpoints/scheduled_reports.py:282` | `POST /scheduled-reports/ledger/{key}/ai-summary/regenerate`（`:286` 函数体，`:297` 调 ledger 服务） |
| `backend/app/services/scheduled_report/ledger_service.py:430` | `regenerate_ledger_ai_summary_async()`（`:450` 内部 `enqueue_ai_summary_generation`） |
| `backend/app/services/scheduled_report/ledger_service.py:309` | `generate_ai_summary_for_delivery_log()` |
| `backend/app/celery_tasks/ai_summary.py:159,181` | 任务侧调用 + `semaphore_timeout` / `submit_failed` 降级打点 |
| `backend/app/services/scheduled_report/ai_schedule_report.py` | `_fallback_summary()` 的 `record_fallback(ai_summary, reason=...)` |

`backend/scripts/insight_gate.py` 对这类 target 直接给「不可退役」，并在结论里单列
「本阶段不退役」——不会因为它的调用方还在就把 canonical 的结论算成未清零。

### 4.3 保留项（回滚需要，验收 §3）

- 旧 URL 与旧**读**端点：`GET /ai-insights`、`/latest`、`/{id}`、`/{id}/stream`、
  `/schedules`、`/ad-agent/evolution-report`；
- 历史表：`ai_insights`、`insight_schedules` 等一律不动（非目标：不删历史表）；
- 旧枚举 / 旧 schema 的只读兼容。

---

## 五、切换时间窗、回滚开关与负责人（验收 §4）

**回滚开关就是既有的域开关，不新造平行开关**：`Settings.insight_canonical_domains`
（CSV；`backend/app/services/insight/domain_switch.py`）。

语义（`legacy_write_frozen` 的冻结点是「所有**新建**旧 `AIInsight` 行的入口」，
在途 pending 行不拦 —— 否则切换瞬间的 pending 会永久悬挂）：

| 开关状态 | 效果 |
|----------|------|
| 空 CSV | 只走 legacy；canonical 域端点 409 `DOMAIN_SWITCH_NOT_READY` |
| 含某域（如 `ad_analysis`） | 该域的 legacy 写入口冻结（409，禁双写）；canonical 生效 |

**切换时间窗**

1. 冻结 legacy 写（旧 URL 保留、历史只读可用、**不删任何东西**）；
2. 观察 `insight_observation_window_days`（默认 7）天，`python scripts/insight_gate.py` 出报告；
3. 三票齐备（指标达标 + 调用方清零 + 回滚演练通过）且负责人拍板后，才允许按 §4 删除；
4. 任何一步指标异常 → 立即回滚。

**回滚步骤**：置空 `INSIGHT_CANONICAL_DOMAINS`（或移除对应域）→ 重启 `believeboy-api`
与 Celery worker → legacy 写端点立即恢复；canonical 域端点回到 409。**无需改代码、无需回滚迁移**
（观测表只增不改，留着不影响旧链路）。

**负责人**：Damon（后端工程师）—— 冻结/回滚操作、指标复盘、删除执行；
合并把关 Tia；前端退役面由 Seth（BLF-1017）承接。

---

## 六、真流式（BLF-1071）对门禁阈值的影响与结论

**背景**：BLF-1071 把执行器从「一 run 一帧整段 delta」改成「每个 provider token 一帧
`content.delta`」。两个门禁口径随之变化：

| 指标 | 变化 | 结论 |
|------|------|------|
| `first_delta_ms` | 从「产出时延」变成**真首字时延** | 口径变严、数值变小。`il_gate_max_first_delta_ms`（90_000 = `ai_chat_timeout_seconds`）**不必调整**：首字必然早于整段产出，原阈值仍有充足余量，调小反而会把慢模型误判为超时 |
| `stream_frames` | 每 run 从 ~1 帧升到 **O(输出 token 数)** | 数量级上升，但**不必调整阈值**（见下） |

**`insight_stream_maxlen`（默认 10000）够不够？—— 够，建议维持默认。**

关键事实：`stream_key(run_id)` 是 **per-run** 的（`bb:insight:stream:{run_id}`），所以
`maxlen` 约束的是**单个 run 自己的窗口**，不是全库共享预算。按此实测：

| delta 粒度 | 1540 字报告（三域 5 段中文分析的典型量级）的帧数 | 单 run 溢出窗口的正文长度 |
|-----------|--------------------------------------|------------------------|
| 1 字符/帧（最坏） | ~1540 | > 9994 字 |
| 2 字符/帧 | ~770 | > 19988 字 |
| 4 字符/帧 | ~385 | > 39976 字 |

即：**只有当单次输出超过约 1 万字（最坏粒度）才会滚出窗口**，而三个域的 prompt 都要求
「5 段结构化中文分析」，正常输出在 1.5–3k 字量级，距溢出还有 3× 以上余量。

即使真的溢出，**降级路径是安全的**（BLF-1012 已建）：`content.snapshot` 帧 + snapshot
checkpoint 让断线续传回退到「快照重建」而非丢内容（subscriber 的
`_resume_snapshot` 分支），观感退化但数据不丢。

**因此建议（不直接改阈值，按 issue 要求只给结论）**：

1. `il_gate_max_stream_frames` 维持 `10000`。它原本锚定 `insight_stream_maxlen`（= 保留窗口
   上限），而 BLF-1071 后 `stream_xlen` 仍以 maxlen 为上限，**锚定关系不变**；改小会误报
   「保留窗口耗尽」。
2. `il_gate_max_first_delta_ms` 维持 `90_000`。口径变了但阈值本来就锚定 provider 调用预算，
   不是经验值，无需跟着动。
3. 新增可选项（非本次改动）：如果运维想在溢出**发生前**预警，可把
   `insight_gate_max_stream_frames` 设为 `insight_stream_maxlen` 的一个比例（如 8000），
   把「接近窗口上限」变成 warning；默认仍是 10000（只在真触顶时报）。
4. 若未来单次报告长度预期突破 1 万字，优先调 `insight_stream_maxlen`（它是 window 大小），
   而不是放宽门禁。

**观测期读法提醒**：唯一需要重新建立 baseline 的是 `stream_frames` / `stream_bytes`
两列的**绝对量级**（会跳一个数量级）。观测窗口内做同比时，`first_delta_ms` 的改善与
`stream_frames` 的跃升都是**预期行为**，不是回归。

---

## 七、已知限制

1. **`frontend/types/api-generated/openapi.json` 无法在本栈重生成**：
   `python -m scripts.openapi_export` 全仓库失败（`KeyError` 落在首个路由
   `POST /api/v1/auth/login`，`fastapi/_compat/v2.py:275`），与本改动无关 ——
   `requirements.txt` 固定 `fastapi==0.139.0` 但未固定 `pydantic`。
   该 artifact 对全仓库已过期（`insight/runs` 0 命中，最后更新 `c3442057`），
   因此**没有**手工改它，也没有声称重生成；新增端点的契约由
   `scripts/export_insight_contract.py`（canonical fixtures）与后端测试保证。
2. **观测端点是管理员级**：非管理员拿不到跨项目聚合（403）。前端若要展示，需要 Seth 侧
   明确以管理员身份调用，或后续补 per-project 视图 —— 但 per-project 视图不能用于退役裁决。
3. **成本异常判定需要样本**：窗口内 token 样本少于 3 个时不判（中位数样本不足易误报），
   此时 `cost_anomalies` 为空。
