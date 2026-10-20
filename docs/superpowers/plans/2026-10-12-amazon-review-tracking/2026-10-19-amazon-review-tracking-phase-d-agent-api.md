# Amazon 评论追踪阶段 D 实施计划：Agent 采集 API（BLF-1378）

> **范围**：阶段 D——对外提供 Agent 采集入口：读 active 目标 + 按目标（= 一个评论共享组 / 一个外部 ASIN）回传采集结果。
> **上游**：[阶段 A](./2026-10-12-amazon-review-tracking-phase-a.md) · [阶段 B 总览](./2026-10-16-amazon-review-tracking-phase-b.md) · [阶段 B 报告](./phase-b-report.md) · 设计稿 [§8.3 / §8.5 / §10](../../specs/2026-10-12-amazon-review-tracking-design.md)
> **状态**：实现前的定稿计划（本文件与实现同 PR 提交）。

## 0. 结论先行

| 决策点 | 结论 |
| --- | --- |
| 业务域 code | **`review_tracking`**（定稿，四处注册表同步） |
| 路由数 | **2 条**：R1 读目标、W1 提交一次采集结果 |
| confirm 流 | **不需要**。W1 幂等（`(target_id, idempotency_key)` 唯一）+ 只增量写入，无金钱/不可逆状态；沿用 platform-inspection W1 先例 |
| 迁移 | **无新增迁移**（表已齐，见 §2）；「抓取规则」走**常量下发**，不加列（见 §3） |
| 服务层 | 零改造——W1 只是 `record_crawl_result` 的薄封装 |
| 测试档位 | **T3**（新增域 code + 审计映射 + 共享注册表），全量 pytest 一次 + 失败集对账 |

## 1. 覆盖映射（issue → 任务）

| issue 条目 | 覆盖 |
| --- | --- |
| §1 新业务域 `review_tracking` | Task 1（注册） |
| §2 R1 读目标 | Task 2 |
| §3 W1 提交结果 | Task 3 |
| §4 确认流（不需要） | Task 3 + 本文 §5 |
| §5 契约与文档 | Task 4 |
| §验收（目标集 + 全量 + 端到端） | Task 5 |

## 2. 数据底座复核（零迁移）

现有 5 张表（迁移 282）足以承载 W1 的**全部**入参，无需加列：

| W1 入参 | 落点 |
| --- | --- |
| `captured_at` / `status` / `is_complete_list` / `asin_scraped` / `error_message` / `idempotency_key` | `amazon_review_crawl_runs` |
| `rating.*`（均分 / 评分数 / 评论数 / 1–5 星百分比或绝对数 + `star_count_quality`） | `amazon_review_rating_snapshots`（`UNIQUE(target_id, capture_date)`，同日 upsert） |
| `reviews[]` | `amazon_review_reviews`（`UNIQUE(target_id, review_key)`，当前记录 upsert + `missing_streak` / `visibility_status`） |

**`source` 列**：W1 固定写 `"agent_review_tracking"`（或 Agent 显式声明的 `source` ≤64 字符），用于区分采集渠道，不新增列。

## 3. 未决点：「抓取规则」怎么下发

设计稿 §8.3 要求 Agent 先读「active 目标 + 抓取规则」。但**库里没有抓取规则字段**（`amazon_review_targets` 只有 `kind/group_id/project_id/marketplace/asin/display_name/is_active`）。

**决策：常量下发，不加列、不加表。**

理由：
1. 运营侧还没有「按组配置抓取规则」的需求与 UI（阶段 C 页面也未包含），先加列等于把未定稿的产品口径固化进 schema；
2. 现阶段真正需要 Agent 遵守的规则**全部是服务端已强制的语义**（同日一快照、两连缺失判疑似移除、完整列表前提、`star_count_quality` 词表、`id_confidence` 词表），这些是常量而非按组配置；
3. 常量下发可以在不改库、不写迁移的前提下先跑通链路，后续若产品要「按组配频率/分页」，再单独立项加列（届时只需把常量换成 target 字段，响应契约不变）。

R1 顶层 `crawl_rules`（常量，随响应下发一次，不在每个 item 里重复）：

```json
{
  "schema_version": 1,
  "business_timezone": "Asia/Shanghai",
  "snapshot_granularity": "one_per_target_per_business_date",
  "removal_rule": {
    "requires_status": "success",
    "requires_complete_list": true,
    "consecutive_misses": 2
  },
  "idempotency": {"key_scope": "per_target", "max_length": 64},
  "status_values": ["success", "partial", "failed"],
  "star_count_quality_values": ["exact", "estimated", "unavailable"],
  "id_confidence_values": ["original", "derived"],
  "notes": [
    "失败（status=failed）只落运行记录，不写快照与评论",
    "评分快照与评论分开处理：本次没有抓到评论也要提交已取得的评分快照",
    "1–5 星百分比是页面原始比例，不能据此声称精确星数"
  ]
}
```

**明确不下发**（服务端不约束、由采集侧决定，避免假装有协议）：分页大小、抓取频率、UA/代理、翻页停条件。频率只在设计稿里以「一周 1–2 次」的建议出现，不写进契约。

## 4. 鉴权 / 范围 / 限流 / 审计

| 项 | R1 读目标 | W1 提交结果 |
| --- | --- | --- |
| 凭据 | `require_agent_credential`（命名空间级） | 同左 |
| 业务域 | `require_business_scope("review_tracking")`（装配时挂） | 同左 |
| 项目范围 | `project_scope` 在 handler 内过滤（路径无 `project_id`） | handler 内校验目标归属 |
| 写限流 | —（读桶） | `require_agent_write_rate_limit` |
| confirm | 否 | 否（§5） |
| 操作审计 | 不落（读不审计，设计稿 §3.3） | `append_operation_audit_log`（`operator=NULL`，`agent_id` / `agent_name` / `idempotency_key` 归因） |
| 访问审计 | 中间件自动记（`operation_type=review_tracking`） | 同左 |

**项目范围口径（R1）**：
- `project_scope == "*"` → 全量 active 目标；
- 白名单 → 只返回 `project_id` 在白名单内的 `internal_group` 目标；
- **外部目标（`kind=external_asin`，`project_id IS NULL`）跨项目可见**——与阶段 B 运营读 API 的既有实现一致（`or_(kind=='external_asin', project_id.in_(...))`）。外部 ASIN 是「竞品追踪」全局共享数据，不含项目私有信息。**此口径仍待产品确认**（阶段 B 报告 §5.2 已列为遗留项），本阶段不改变行为，只在 docstring 与 PR 里显式标注。

**项目范围口径（W1）**：
- `internal_group` 目标 → 复用 `require_project_scope(target.project_id, request)`，不在范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`（与其它写域一致）；
- `external_asin` 目标 → 无项目归属，持 `review_tracking` 域的凭据即可提交（同 R1 口径，待产品确认）；
- 目标不存在 / 已停用 → **404 `RESOURCE_NOT_FOUND`**（停用组不再采集，避免把结果写到已退役的组上）；内部目标越权 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`，**403 与 404 可区分**（403 = 存在但无权、404 = 不存在 / 已停用），是有意的「可自纠」取舍。
- **提交时序护栏**（复审后新增）：`captured_at` 早于或等于该 target 最近一次 run 的 `started_at` → 409 `REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER`。理由：当前态表 `amazon_review_reviews` 无版本，乱序提交会倒退正文 / `last_seen_at`，同一时间戳的重复完整列表还会重复累加 `missing_streak` 产出错误的「疑似移除」。等值时再查幂等键，避免真并发的同键输家被误拒；已存在的同键仍先走重放路径。同日更晚重跑不受影响。护栏是尽力而为（无数据库级约束），若产品确需允许补采，必须先加版本或改成条件更新。**第二轮复审修正**：水位只统计真的写过当前态、且时间可信的 run——排除 `status='failed'`（否则「09:31 首次尝试失败 → 09:30 重试成功」被永久 409），并排除 `started_at` 超出未来容差的 run（旧版本无上限时写进的脏数据；不排除就等于永久锁死，而本域没有删 run / 重置水位的入口）；
- **`captured_at` 未来上限**（第二轮复审新增）：晚于 `now + MAX_CAPTURED_AT_FUTURE`（2h，见 `app/constants/amazon_review_crawl_rules.py`）→ 400 `VALIDATION_FAILED`（`reason=captured_at_in_future`），不落 run / 快照。不设上限时一次客户端时区标错就会写出未来 `capture_date` 的快照、把水位抬到未来，而产品内没有删 run / 重置水位的入口（永久锁死）。属于输入合法性，幂等重放同样 400；`REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER` 的 `agent_hint` 按水位是否落在未来分叉（未来 → 提示核对时钟/时区、等墙钟越过，不引导伪造更晚的时间）；读取端忽略超容差未来水位（旧版脏数据）作为唯一自动恢复路径，与写入端上限配对；
- **重放 `capture_date`** 一律由已持久化 run 的 `started_at` 推业务日，不用本次 payload 的 `captured_at`。
- **`idempotency_key` 空白**（如 `"   "`）→ 400 `VALIDATION_FAILED`（与空白 `Idempotency-Key` 头口径对齐；否则会被静默降级为 `None`，同请求重复提交落两行 run）。

## 5. 为什么 W1 不走 confirm

`require_confirmation` 用于「涉及金钱 / 不可逆状态」的写。W1：
- 幂等（同 `idempotency_key` 重复提交 → 返回首次 run，不新增行）；
- 只做追加与「当前记录更新」：同日快照覆盖当天那一行、Review 只更新当前记录（首次/最近观察时间保留）；
- 没有删除、没有金额、没有不可逆状态推进。

对照先例：platform-inspection **W1 保存草稿**（可反复覆盖）同样不 confirm，**W2 提交**（不可逆）才 confirm。W1 更接近前者。→ **不做 confirm**。

## 6. 路由契约

### 6.1 R1 `GET /api/v1/agent/review-tracking/targets`

query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `marketplace` | str? | ISO 站点（`US` / `DE` / `UK`…），大写归一 |
| `kind` | `internal_group` \| `external_asin`? | 目标类型过滤 |
| `project_id` | int? | 只看指定项目；不在凭据范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE` |
| `limit` | int = 200（1..500） | 分页 |
| `offset` | int = 0 | 分页 |

响应 `data`：

```json
{
  "items": [
    {
      "target_id": 12,
      "kind": "internal_group",
      "group_id": 5,
      "project_id": 3,
      "marketplace": "US",
      "asin": "B0G6C865B6",
      "display_name": "户外水壶-共享组",
      "external_shop_ids": [],
      "last_run": {
        "run_id": 88,
        "status": "success",
        "started_at": "2026-10-18T10:00:00+00:00"
      }
    }
  ],
  "total": 1,
  "crawl_rules": { "...见 §3..." }
}
```

- `asin`：内部目标 = 组代表 ASIN（`target.asin`），外部目标 = 竞品 ASIN；两者形态一致，Agent 不需要分支解析。
- `external_shop_ids`：仅外部目标有值（`amazon_review_external_links` 里 `is_active=true` 的 `shop_id`），内部目标恒 `[]`。
- `last_run`：该目标最近一次 run（`started_at` 最大）的 `id/status/started_at`，给采集侧判断「今天是否已经跑过」。批量一次查询，不做 N+1；无 run → `null`。
- 只返回 `is_active=true` 的目标。

### 6.2 W1 `POST /api/v1/agent/review-tracking/targets/{target_id}/runs`

headers：`Authorization` / `X-Agent-Id` 必需；`Idempotency-Key` 可选（≤64）。

body（pydantic `AgentCrawlResultRequest`，`extra="forbid"`）：

```json
{
  "captured_at": "2026-10-19T09:30:00+08:00",
  "status": "success",
  "rating": {
    "average_rating": 4.3,
    "rating_count": 128,
    "review_count": 96,
    "star_percentages": [7.0, 3.0, 6.0, 20.0, 64.0],
    "star_counts": null,
    "star_count_quality": "estimated"
  },
  "reviews": [
    {
      "review_key": "R1F90C6R6GV8L6",
      "id_confidence": "original",
      "rating": 5,
      "title": "好用",
      "body": "……",
      "reviewer_id": "A1B2C3",
      "reviewer_name": "张三",
      "review_date": "2026-10-10",
      "verified_purchase": true,
      "helpful_count": 3
    }
  ],
  "is_complete_list": true,
  "idempotency_key": "2026-10-19:target-12:us",
  "asin_scraped": "B0G6C865B6",
  "error_message": null,
  "source": "agent_review_tracking"
}
```

校验分工：
- **pydantic 负责形态**：`captured_at` 用 `AwareDatetime`（naive → 400）、枚举、`1..5` 星、`star_percentages`/`star_counts` 长度必须 5、`reviews` 最多 500 条、字符串长度上限（对齐列宽：`review_key` 255 / `title` 512 / `body` 不限但切片前限 20000 / `error_message` 4000）；
- **服务层负责语义**（`record_crawl_result` 原有校验，零改动）：星数百分比 0–100、计数非负整数、非有限数拒绝；
- 两层的错误都映射成 **400 `VALIDATION_FAILED`**（pydantic 走 `RequestValidationError` 处理器，服务层 `IngestionError` 在 handler 内翻译）。

`idempotency_key` 取值：body 字段优先，缺省回退 header `Idempotency-Key`；两者都给且不一致 → 400 `VALIDATION_FAILED`（避免「body 说 A、审计说 B」的歧义）。长度 ≤64（与其它 agent 写域一致，审计列宽 64）。

响应 `data`：

```json
{
  "target_id": 12,
  "run_id": 88,
  "status": "success",
  "capture_date": "2026-10-19",
  "snapshot_updated": true,
  "reviews_upserted": 1,
  "reviews_suspected_removed": 0,
  "replayed": false
}
```

- `replayed=true` + 首次的 `run_id`：同幂等键重复提交（不新增行）。实现方式：调用服务前后各查一次 `(target_id, idempotency_key)` 的 run——服务层已保证幂等（含并发 savepoint 路径），这里只负责如实告知 Agent「这是重放」，不改服务。
- 审计：只在**真正新建 run** 时落 `review_tracking.crawl_run`（`target_type=amazon_review_crawl_run`，`target_id=run_id`，`after` 记 target/status/capture_date/计数）；重放不落行（读语义的 no-op 不算写）。
- `status=failed`：只落 run，`snapshot_updated=false`、`reviews_upserted=0`（服务层语义，本阶段不改）。

## 7. 实现清单（文件级）

| # | 文件 | 动作 |
| --- | --- | --- |
| 1 | `backend/app/api/agent/scope.py` | `KNOWN_BUSINESS_DOMAINS` += `review_tracking` |
| 2 | `backend/app/middleware/agent_api_audit.py` | `AGENT_PATH_DOMAIN_MAP` += `("/review-tracking", "review_tracking")` |
| 3 | `backend/tests/api/test_agent_api_audit_path_meta.py` | `KNOWN_DOMAINS` += `review_tracking`；补 path 解析用例 |
| 4 | `backend/app/schemas/amazon_review_tracking_agent.py` | 新：W1 请求 schema（`AgentCrawlResultRequest` / `AgentRatingCapture` / `AgentReviewCapture`） |
| 5 | `backend/app/api/v1/endpoints/agent/review_tracking.py` | 新：R1 + W1 路由、常量 `CRAWL_RULES`、壳翻译、范围校验、审计 |
| 6 | `backend/app/api/v1/endpoints/agent/__init__.py` | include `review_tracking_router`（兜底路由之前）+ `require_business_scope("review_tracking")` |
| 7 | `backend/tests/api/agent/test_review_tracking.py` | 新：R1 / W1 / 鉴权 / 幂等 / 审计 / 范围 用例 |
| 8 | `docs/agent-api-design.md` | 新增本域段落 + 版本升 v0.14 + 修订记录 |
| 9 | `frontend/types/api-generated/openapi.json`（+ `api.d.ts`） | `make openapi-export` / `pnpm gen:api-types` 重新生成（生成物，不算「改前端」） |
| 10 | `frontend/lib/agent-domains.ts` | **不动**：本 issue 只做后端，评论区 @ 前端工程师 Seth 补注册（域 code / 标签 / 路由数 2 / read+write） |

## 8. 测试清单

**目标集（T2 层）**：`backend/tests/api/agent/test_review_tracking.py`

R1：
- [ ] 未鉴权 401；缺 `review_tracking` 域 403 `AGENT_BUSINESS_OUT_OF_SCOPE`
- [ ] 只返回 active 目标（停用组/停用外部目标不出现）
- [ ] `project_scope` 白名单 → 只看到范围内的内部目标；外部目标仍可见（口径固化）
- [ ] `?project_id=` 越权 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`
- [ ] `?marketplace=` / `?kind=` 过滤；分页 `limit/offset` + `total`
- [ ] `crawl_rules` 常量存在且 `business_timezone=Asia/Shanghai`
- [ ] `external_shop_ids` 只含 active link；`last_run` 取最近一次

W1：
- [ ] 成功提交 → run + 同日快照 + 评论落库，响应计数正确
- [ ] 同幂等键重复提交 → `run_id` 相同、`replayed=true`、run 行数不变、快照不重复写
- [ ] body 键与 header 键不一致 → 400；只有 header → 按 header 幂等
- [ ] `status=failed` → 只落 run（无快照/评论行）
- [ ] `is_complete_list=true` + 连续两次缺失 → `reviews_suspected_removed=1`
- [ ] naive `captured_at` → 400；`star_percentages` 长度 4 → 400；`rating=6` → 400；`status` 非法 → 400
- [ ] 目标不存在 / 已停用 → 404
- [ ] 内部目标项目越权 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`
- [ ] 审计行：`action=review_tracking.crawl_run`、`agent_id`、`idempotency_key`、`operator is NULL`；重放不新增审计行
- [ ] `KNOWN_BUSINESS_DOMAINS` 含 `review_tracking`

**回归集**：`tests/api/test_agent_api_audit_path_meta.py`、`tests/services/test_amazon_review_ingestion_service.py`、`tests/api/test_amazon_review_ops.py`。

**T3 全量**：`cd backend && pytest`（禁 `-n auto`）一次 + 失败集对账（对 main 同环境定向复跑失败集，不跑第二遍全量）；`python scripts/check_alembic.py`；`tests/scripts/test_openapi_export.py`。

**端到端手验**：签发带 `review_tracking` 的 key → R1 读目标 → W1 提交成功结果 → 同幂等键重提（run 数不变）→ W1 提交 `failed`（只落 run）→ 运营侧 `GET /api/v1/amazon-review-tracking/targets/{id}/runs` 可见。

## 9. 风险与遗留

| # | 项 | 处理 |
| --- | --- | --- |
| 1 | 外部目标跨项目可见/可写 | 沿用阶段 B 实现，docstring + PR 标注，**待产品确认**；如需收紧，改为「按 active link 的 shop 所属项目判定」即可（一处判定函数） |
| 2 | 「抓取规则」无库字段 | 常量下发（§3），后续要按组配置再单独立项加列 |
| 3 | 前端域注册表未同步 | 本 PR 评论区 @ Seth；期间审计访问日志的域会显示原 code（前端 `getAgentDomain` 未知 code 的既有 fallback） |
| 4 | `replayed` 判定是「请求开始前是否已有同键 run」，并发极端情况下可能报 `false` | 不影响正确性（`run_id` 始终是首次那一行），文档写明 |
| 5 | 无 `reviews` 上限之外的请求体大小保护 | 500 条 + 字段长度上限；如需总字节上限，后续在网关层加 |
