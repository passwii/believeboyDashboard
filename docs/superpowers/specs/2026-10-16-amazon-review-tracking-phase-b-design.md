# Amazon 评论追踪 · 阶段 B 后端设计规格

> **状态：** 待用户审查（brainstorming 定稿草案）
> **日期：** 2026-10-16
> **配套文档：**
> - 主设计稿（需求与已确认方向）：[`2026-10-12-amazon-review-tracking-design.md`](./2026-10-12-amazon-review-tracking-design.md)
> - 阶段 A 计划：[`../plans/2026-10-12-amazon-review-tracking/2026-10-12-amazon-review-tracking-phase-a.md`](../plans/2026-10-12-amazon-review-tracking/2026-10-12-amazon-review-tracking-phase-a.md)
> - 阶段 A 失败集对账：[`../plans/2026-10-12-amazon-review-tracking/task-5-failure-reconciliation.md`](../plans/2026-10-12-amazon-review-tracking/task-5-failure-reconciliation.md)
> **范围声明：** 本文只设计**阶段 B 后端**（数据模型 + 迁移 + 采集结果写入服务 + 运营查询/维护 API）。不含阶段 C 页面、阶段 D Agent 对外 API。落到步骤见后续实施计划（writing-plans）。

---

## 0. 拍板结论摘要

| # | 议题 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 内部共享组与外部竞品的统一建模 | 新建 `amazon_review_targets`（`kind`），作为快照/Review/运行记录的**唯一挂载点**；内部目标与阶段 A 组 1:1，外部目标按 `(marketplace, asin)` 唯一 | 阶段 A 组表外键绑死 `product_costs`，装不下外部 ASIN |
| 2 | 抓取目标 = 组还是 ASIN | 目标是统一单元；内部组只抓**代表 ASIN**，组内不重复抓 | handoff「组内 ASIN 不重复抓取」 |
| 3 | 写入路径放 B 还是 D | 领域**写入服务**放 B（服务层测试覆盖幂等/两连缺失），**对外接口**放 D（复用 B 服务） | 写入语义是最大风险，先测服务最省；对外鉴权天然属 D |
| 4 | 快照唯一性 | `(target_id, capture_date)` 唯一；同日重试 **UPDATE 该日行**，运行记录不删 | handoff「同日重试更新该日快照，保留运行记录」 |
| 5 | ratings 与 reviews 计数 | 分列存储；`review_count` 不可得留 `null`，**绝不用 `rating_count` 顶替** | 设计稿 §4.1 |
| 6 | 星级绝对数质量 | `star_count_quality ∈ {exact, estimated, unavailable}`；页面只有百分比时不得写精确值 | 设计稿 §4.2 |
| 7 | 缺失与零 | 一律 nullable + 显式状态；缺采/失败不写 0 | 设计稿 §4.5 |
| 8 | 业务日期时区 | `capture_date` 归到固定 `Asia/Shanghai`；`captured_at` 存真实时刻（带时区） | 需固定日界线，避免跨站点漂移 |
| 9 | Review 身份 | 优先页面/DOM/URL 原生 ID（`id_confidence=original`）；否则指纹推导（`derived`），不承诺稳定 | handoff §已确认方向 |
| 10 | 疑似移除判定 | 仅**完整列表且成功**的运行参与；连续 2 次未出现 → 疑似移除；再现 → 恢复 | handoff §已确认方向 |
| 11 | 关系变更与历史 | 改组/换代表/停用**不迁移历史** | handoff §已确认方向 |
| 12 | 权限 | 读 = 运营/管理员会话；外部关联维护 = 管理员 | 用户拍板（2026-10-16） |
| 13 | 合规与留存 | 按下方默认执行，标注「待合规确认」 | 用户拍板（2026-10-16） |
| 14 | 下一条迁移 | `282`（当前 head `281`；实施前先同步 `origin/main` 确认单链） | AGENTS.md §数据库与迁移 |

---

## 1. 目标态数据流

```text

【两条商品来源】
 内部商品 Project/SQ info                          外部竞品（「评论追踪」页临时登记）
  SKU info 行(product_costs) + 运营配置「评论共享组」    仅关联 project_shops，不进 SKU info
   成员=若干 SKU 行(同 project+marketplace)、代表 ASIN    默认每个 ASIN 自成一个目标
                 │                                              │
                 └──────────────────┬───────────────────────────┘
                                    ▼
                 amazon_review_targets  (kind=internal_group | external_asin)
                                    │   阶段 D：Agent 读「active 目标 + 代表 ASIN + marketplace + 规则」
                                    ▼
                         Agent 抓 Amazon 页面 → 按目标独立提交结果
                                    │
        ┌───────────────────────┬────────────────────┬─────────────────────┐
        ▼                       ▼                    ▼
 amazon_review_             amazon_review_       amazon_review_
 rating_snapshots           reviews              crawl_runs
 (目标×业务日 一份)          (当前记录 + 可见性)     (每次抓取运行/完整性/幂等)
        └───────────────────────┴────────────────────┴─────────────────────┘
                                    │   阶段 C：评论追踪页面（趋势 + 评论明细 + 外部关联管理）
                                    ▼
                        趋势图 hover（均分 / ratings 总数 / 评论数 / 1–5 星占比与精度）+ 评论明细
```

### 单个产品走一遍

- 内部：Project=P、US 组「父体共享合集」，成员 A1/A2/A3、代表 A1 → 一个 `target(internal_group)`；Agent 只抓 A1 的 US 页面；评分/评论记在该 target 下。
- 外部：US + ASIN `B0XXXX` → 自动一个 `target(external_asin)`，可关联多个 `project_shops`；移除关联只软标记，重加恢复原行、沿用历史。

---

## 2. 数据模型

所有新表主键用 `Integer`；引用 `projects.id` / `product_costs.id` 的外键列按其实际类型用 `BigInteger().with_variant(Integer, "sqlite")`；引用 `project_shops.id` 的列用 `Integer`（该表主键为 `Integer`）。时间列用 `DateTime(timezone=True)`。

### 2.1 `amazon_review_targets`（新增，统一挂载点）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `kind` | String(20) NOT NULL | `internal_group` \| `external_asin` |
| `group_id` | Integer NULL | 内部目标 → `amazon_review_groups.id`（`RESTRICT`） |
| `project_id` | BigInteger NULL | 内部目标所属 Project（外部为 NULL） |
| `marketplace` | String(2) NOT NULL | 站点 |
| `asin` | String(20) NULL | 内部=当前代表 ASIN；外部=该 ASIN |
| `display_name` | String(255) NULL | 展示名（外部可用 ASIN） |
| `is_active` | Boolean NOT NULL default true | 目标是否仍在采集 |
| `created_at` / `updated_at` | DateTime(tz) NOT NULL | |

约束与索引：

- `CHECK kind IN ('internal_group','external_asin')`。
- `CHECK ((kind='internal_group' AND group_id IS NOT NULL AND project_id IS NOT NULL) OR (kind='external_asin' AND group_id IS NULL AND project_id IS NULL AND asin IS NOT NULL))`。
- `UNIQUE (group_id)`：内部组 → 目标 1:1（PostgreSQL 唯一约束允许多个 NULL，外部行不受影响）。
- 部分唯一索引 `(marketplace, asin) WHERE kind='external_asin'`：一个 Marketplace+ASIN 只有一套外部追踪数据（禁用/移除不换 ID，重加沿用历史）。
- `INDEX (kind, is_active)`、`INDEX (group_id)`。

> 归一化取舍：`marketplace` 只存在 target 上，快照不再冗余该列；如需页面直接按 `(marketplace, asin)` 查，走 target 关联。

### 2.2 `amazon_review_rating_snapshots`（新增）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `target_id` | Integer NOT NULL | → `targets.id`（`RESTRICT`） |
| `capture_date` | Date NOT NULL | 业务日期（`Asia/Shanghai`） |
| `captured_at` | DateTime(tz) NOT NULL | 真实抓取时刻 |
| `average_rating` | Numeric(3,2) NULL | 页面均分 |
| `rating_count` | Integer NULL | global ratings 数 |
| `review_count` | Integer NULL | 可获取的**有正文**评论数（不可得为 NULL） |
| `star_1_percentage` … `star_5_percentage` | Numeric(5,2) NULL | 页面原始百分比 |
| `star_1_count` … `star_5_count` | Integer NULL | 各星级绝对数 |
| `star_count_quality` | String(12) NOT NULL default `'unavailable'` | `exact` \| `estimated` \| `unavailable` |
| `capture_status` | String(16) NOT NULL | `success` \| `partial` |
| `source` | String(64) NULL | 采集方式/来源标识 |
| `raw_payload` | JSON NULL | 原始解析结果（排查用） |
| `created_at` / `updated_at` | DateTime(tz) NOT NULL | |

约束与索引：

- `UNIQUE (target_id, capture_date)`；`INDEX (target_id, capture_date)`。
- 仅在**拿到评分级数据**时写快照（`success` / `partial`）；完全没拿到数据的失败运行只写 `crawl_runs`，不写快照。
- 同日重试：存在当日行 → `UPDATE`（并刷新 `captured_at`）；不存在 → `INSERT`。

### 2.3 `amazon_review_reviews`（新增，当前记录）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `target_id` | Integer NOT NULL | → `targets.id`（`RESTRICT`） |
| `review_key` | String(255) NOT NULL | 原生 Review ID 或推导指纹 |
| `id_confidence` | String(16) NOT NULL | `original` \| `derived` |
| `reviewer_id` | String(128) NULL | 可得到才存 |
| `reviewer_name` | String(255) NULL | 仅展示 |
| `rating` | Integer NULL | 1–5 |
| `title` | String(512) NULL | 无标题为 NULL（与空串区分） |
| `body` | Text NULL | 正文 |
| `review_date` | Date NULL | 页面展示日期（标准化后） |
| `verified_purchase` | Boolean NULL | 三态：true / false / 未知(NULL) |
| `helpful_count` | Integer NULL | 可得才存 |
| `first_seen_at` / `last_seen_at` | DateTime(tz) NOT NULL | |
| `visibility_status` | String(20) NOT NULL default `'visible'` | `visible` \| `suspected_removed` |
| `missing_streak` | Integer NOT NULL default 0 | 连续「完整成功」运行未见次数 |
| `raw_payload` | JSON NULL | |
| `created_at` / `updated_at` | DateTime(tz) NOT NULL | |

约束与索引：

- `UNIQUE (target_id, review_key)`；`INDEX (target_id, visibility_status)`；`INDEX (target_id, review_date)`。
- 内容变化只**更新当前行**（不保留版本历史）；`first_seen_at` 不变，`last_seen_at` 刷新。

### 2.4 `amazon_review_crawl_runs`（新增，运行记录）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `target_id` | Integer NOT NULL | → `targets.id`（`RESTRICT`） |
| `idempotency_key` | String(128) NULL | 重复提交去重 |
| `started_at` | DateTime(tz) NOT NULL | |
| `finished_at` | DateTime(tz) NULL | |
| `status` | String(16) NOT NULL | `success` \| `partial` \| `failed` |
| `is_complete_list` | Boolean NOT NULL default false | 本次是否取到**完整评论列表** |
| `reviews_seen` | Integer NULL | 本次见到的评论条数 |
| `ratings_captured` | Boolean NOT NULL default false | 本次是否拿到评分级数据 |
| `asin_scraped` | String(20) NULL | 实际抓取的 ASIN（留痕） |
| `error_message` | Text NULL | |
| `created_at` | DateTime(tz) NOT NULL | |

约束与索引：

- `UNIQUE (target_id, idempotency_key)`（key 非空时）；`INDEX (target_id, started_at)`。
- 同日多次运行各留一行；同一日快照被覆盖也不删运行记录。

### 2.5 `amazon_review_external_links`（新增，外部目标 × 店铺）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `target_id` | Integer NOT NULL | → `targets.id`（仅 `external_asin`） |
| `shop_id` | Integer NOT NULL | → `project_shops.id`（`RESTRICT`） |
| `is_active` | Boolean NOT NULL default true | 软删除标记 |
| `added_at` | DateTime(tz) NOT NULL | |
| `removed_at` | DateTime(tz) NULL | |
| `created_at` | DateTime(tz) NOT NULL | |

约束与索引：

- `UNIQUE (target_id, shop_id)`：重加同一 `(marketplace, asin, shop)` **恢复原行**（`is_active=true`、`removed_at=NULL`），不新建、历史不变。
- `INDEX (target_id, is_active)`；`INDEX (shop_id)`。

### 2.6 关系总览

```text
projects ─┬─ product_costs ── amazon_review_group_members ─┐
          │                                                 ├─ amazon_review_groups ─┐
          └─ project_shops ─────┐                          │   (阶段 A)              │ 1:1
                                │                          │                        ▼
   external_asin 目标 ◄─────────┴── amazon_review_external_links ── amazon_review_targets
                                                                          │ 1:N
                        ┌─────────────────────────────────────────────────┤
                        ▼                        ▼                        ▼
            rating_snapshots              reviews                  crawl_runs
```

---

## 3. 口径与质量约束

1. **ratings ≠ 有正文评论数。** 分列；`review_count` 仅在页面可靠提供时有值，否则 `NULL`。
2. **星级百分比是页面原值。** 只有来源给出精确绝对数才 `exact`；由百分比反推只能 `estimated`；两者都没有 `unavailable`。
3. **空值 ≠ 0。** 缺采、解析失败、页面未提供一律 `NULL` + 状态列，禁止写 0 充数。
4. **缺失 ≠ 删除。** 只有完整成功运行才参与缺席计数。
5. **Reviewer 身份不稳定。** 昵称仅展示，不能当稳定键；取不到 user ID 就留 `NULL`。
6. **可溯源。** 每条运行记录保留 `status` / `is_complete_list` / `source` / 原始载荷，用于解释异常。

---

## 4. 采集结果写入服务行为

服务入口（阶段 D 的 Agent 接口将复用它）：

```text

record_crawl_result(
    db, *,
    target_id: int,
    capture_date: date | None = None,      # 缺省按 Asia/Shanghai 计算
    captured_at: datetime,
    rating: RatingCapture | None,          # None 表示本次没拿到评分
    reviews: list[ReviewCapture] | None,   # None 表示本次未抓评论
    is_complete_list: bool,
    status: Literal["success", "partial", "failed"],
    idempotency_key: str | None = None,
    asin_scraped: str | None = None,
    source: str | None = None,
) -> CrawlResult
```

规则：

1. **幂等**：`(target_id, idempotency_key)` 已存在 → 直接返回既有结果，不重复写。
2. **快照**：`rating` 非空时 upsert `(target_id, capture_date)`；同业务日覆盖更新，`captured_at` 刷新。
3. **Review 汇总**：对本次 `reviews` 中每条按 `review_key` upsert：
   - 已存在 → 更新字段、`last_seen_at=now`、`missing_streak=0`；若原为 `suspected_removed` → 恢复 `visible`。
   - 新增 → `first_seen_at=last_seen_at=now`，`visibility_status='visible'`。
4. **疑似移除**：仅当 `is_complete_list=true` 且 `status='success'` 时，对该 target 下 `visible` 且本次**未出现**的评论 `missing_streak += 1`；`missing_streak >= 2` → `suspected_removed`。不完整/失败运行**不改**任何评论状态与计数。
5. **运行记录**：无论成败都写一行 `crawl_runs`；`status='failed'` 且无评分时只写运行记录。
6. **事务**：以上在同一事务内完成；异常整体回滚，不留部分写入。
7. **按目标独立**：调用方按 target 分别调用；单目标失败不影响其他目标的已提交结果。

---

## 5. API 契约（阶段 B 运营端）

统一前缀 `/api/v1/amazon-review-tracking`；沿用阶段 A 的 `_require_admin`（API key + 有效会话 + 库内管理员）与 `append_operation_audit_log`。读接口用 `get_read_db_session`，写接口用 `get_primary_db_session`。

| 方法 | 路径 | 用途 | 权限 |
| --- | --- | --- | --- |
| GET | `/targets` | 列出目标（筛选 `project_id` / `marketplace` / `kind` / `is_active`），返回 kind、marketplace、asin、group_id、display_name、是否活跃 | 读 |
| GET | `/targets/{target_id}/rating-snapshots` | 趋势数据（`from` / `to` 业务日期区间），返回每日快照序列 | 读 |
| GET | `/targets/{target_id}/reviews` | 评论明细（筛选 `visibility_status`、`review_date` 区间；分页） | 读 |
| GET | `/targets/{target_id}/runs` | 运行记录（分页），用于排障/缺采展示 | 读 |
| POST | `/external-targets` | 登记外部竞品：`{marketplace, asin, shop_id?}`；不存在则建 `external_asin` 目标，存在则复用；带 `shop_id` 时同时 upsert 关联 | 管理员 |
| POST | `/targets/{target_id}/external-links` | 追加店铺关联 `{shop_id}`（已存在则恢复） | 管理员 |
| DELETE | `/targets/{target_id}/external-links/{link_id}` | 软移除店铺关联 | 管理员 |
| GET | `/external-targets` | 列出外部目标及其店铺关联 | 读 |

响应 schema 草案（Pydantic，`extra="forbid"` 于入参）：

- `TargetItem`：`id, kind, group_id, project_id, marketplace, asin, display_name, is_active`。
- `RatingSnapshotItem`：`capture_date, captured_at, average_rating, rating_count, review_count, star_1_percentage..star_5_percentage, star_1_count..star_5_count, star_count_quality, capture_status`。
- `ReviewItem`：`review_key, id_confidence, reviewer_id, reviewer_name, rating, title, body, review_date, verified_purchase, helpful_count, first_seen_at, last_seen_at, visibility_status`。
- `CrawlRunItem`：`id, started_at, finished_at, status, is_complete_list, reviews_seen, ratings_captured, asin_scraped, error_message`。

错误语义沿用阶段 A：`404` 目标/关联不存在、`409` 冲突、`422` 校验失败；写操作失败整体回滚。

**内部目标同步**：阶段 A 的组服务在建组/换代表/停用组时同步维护对应 `target`（建组→建 `internal_group` 目标；换代表→更新 `target.asin`；停组→`target.is_active=false`）。迁移中回填既有组对应的目标。组与目标 1:1 由 `UNIQUE(group_id)` 保证。

---

## 6. 权限矩阵

| 动作 | 要求 |
| --- | --- |
| 查询目标/趋势/评论/运行/外部关联 | 有效会话（运营或管理员） |
| 登记外部竞品、增删店铺关联 | 管理员（沿用 `_require_admin`） |
| 内部共享组维护（阶段 A 既有） | 管理员 |

> 备注：阶段 A 的 `GET /groups` 目前也要求管理员。本阶段新增的**查询**接口按上表放开给运营；是否把 `GET /groups` 一并对齐，列为低优先 follow-up，不在本阶段强改。

---

## 7. 合规与留存（待合规确认）

- 按用户 2026-10-16 拍板：评论正文与其他追踪数据**同等处理**——访问范围同 §6，暂不设独立保留期限与删除流程。
- 已知风险：评论正文与用户相关字段可能涉及隐私与平台条款。**上生产前需合规确认**：可采集范围、访问权限、保留期限、删除请求流程。
- 设计预留：`reviews` 具备按 target 删除/按时间归档的能力（`target_id` 外键 + 时间列），后续可加保留策略而无需改结构。

---

## 8. 非目标（留给后续阶段）

- 阶段 C：评论追踪页面、趋势图、hover、外部关联的**前端**管理界面。
- 阶段 D：Agent 鉴权、目标读取、提交接口、confirm/幂等/限流/审计的对外暴露。
- 定时调度/告警、数据回填、跨组历史迁移工具。
- 审查并清理用户提到的历史遗留（无）。

---

## 9. 待确认问题

1. `project_shops.country` 目前限 `US/DE/UK`——外部竞品是否只在这三个站点开放？若要更多站点，需先放宽该约束（属另一变更）。
2. 外部目标是否**必须**至少关联一个店铺才能被采集？建议：允许先建目标、后关联；无关联时仍可存在但不进 Agent 目标清单。
3. 保留期限/删除流程（§7）待合规给出具体口径后再补。
