# BLF-1266 Stage 2 计划：order-info 聚合热点与翻页契约

> 状态：待执行（Stage 2 计划已定稿）
> 作者：代码质量工程师 Tia ｜ 日期：2026-10-07
> 依据：BLF-1262 前后端 review + **2026-10-07 生产只读 EXPLAIN 实测** + **本地真实数据 DDL 演练**
> 承接：BLF-1263 Stage 1 已上线（`72535252` / `9b0bfb81`）

---

## 【需求确认】

在不改变任何列表 / 统计语义的前提下，把全量口径下 order-info 聚合的 **73%–80% 开销**（`raw_row` JSON 逐行解析）挪到写入期计算，并让**翻页不再重算统计**。

---

## 零、先给结论：本轮已经量化的三件事

### 0.1 热点确认：`raw_row` 是 `json` 不是 `jsonb`，`->>` 每行都要重解析整段 JSON

生产只读 EXPLAIN（2026-10-07，PG 18.1，表 51,611 行 / 481 MB）：

| 查询 | Execution Time | 说明 |
| --- | --- | --- |
| `compute_stats` 主聚合（含 join，含 2 次 `raw_row->>'fulfillment-channel'`） | **652 ms** | 现状 |
| 同一查询把两处 JSON 抽取换成常量 | **175 ms** | **JSON 解析 = 477 ms ≈ 73%** |
| 主导币种 `GROUP BY currency` | 226 ms | 与 JSON 无关 |
| 近 7 天窗口主聚合 | **2.6 ms** | 热点只在宽口径，窄口径无需优化 |

平均每行 ~9.3 KB 的 JSON 文本，每行被 `->>` 解析两次——这就是全量口径 1.6 s 的来源。

### 0.2 修法确认：STORED generated column，实测 **13×**

把本地 `BLF` 快照的**真实表**（51,583 行 / 156 MB）灌进临时库做演练，前后同一口径对拍（热缓存，各跑两次取稳定值）：

| 形态 | Execution Time |
| --- | --- |
| `sum(case when raw_row->>'fulfillment-channel' = … )` | 214 ms / 224 ms |
| 同一张表加 generated column 后 `sum(case when fulfillment_channel = … )` | **17.3 ms / 15.6 ms** |

**约 13×。** 推算生产：主聚合 652 ms → 150–200 ms；`/overview` 统计合计 878 ms → 约 300 ms。

### 0.3 代价确认：**PG 18 上 `ADD COLUMN … STORED` 会整表重写**（不是"瞬时加列"）

本地同一次演练里 `pg_class.relfilenode` 从 `31806642` → `31806734`，**relfilenode 变了 = 表被重写**，耗时 1.45 s（156 MB / 51,583 行 / NVMe）。

生产表是本地的 ~3 倍体积、且是更弱的 VPS，**必须按维护窗口 + 锁超时兜底来执行**（见 S2-D）。

### 0.4 顺带量化：翻页为什么该走已有 `/list`

| 路径 | SQL 条数 | 宽口径（全店铺无日期）耗时 |
| --- | --- | --- |
| 现状 `/overview?page=2`（stats 照跑） | 3 条（agg + currency + 分页） | **≈ 878 ms** |
| 改走已有 `/list?page=2` | 2 条（count + 分页） | **≈ 98 ms**（实测 count 97.6 ms + 分页 0.5 ms） |

**≈ 9×，且零后端改动。**

---

## 一、任务分解

### S2-A · 聚合热点：fulfillment-channel 生成列（P0，backend）

- **角色**：backend
- **依赖**：无
- **产出**：
  1. `backend/alembic/versions/2026MMDD_278_*.py`，`revision='278'`（接 `20261006_277_agent_monthly_reports`），内容为 PG 侧
     `ALTER TABLE analysis_sales_order_rows ADD COLUMN fulfillment_channel text GENERATED ALWAYS AS (coalesce(raw_row->>'fulfillment-channel', raw_row->>'fulfillment channel')) STORED`，
     并按 dialect 守卫（非 PG 直接 no-op）；`downgrade` 对称 `DROP COLUMN`。
  2. `backend/app/models/product_analysis_source.py`：`AnalysisSalesOrderRow` 增加 `fulfillment_channel` 映射列。
  3. **不建索引**（已用生产数据证伪其价值：Amazon 51,519 / Merchant 92 = 99.8% / 0.2%，选择性极差，只会给写入路径加成本）。
- **验收标准**：
  1. 生产数据实测：`fulfillment_channel IS NULL` 的行数为 **0**；两个取值分布与 `raw_row->>'fulfillment-channel'` **逐值相等**；
  2. 迁移后表列数 / 行数不变（51,611 行），`pg_total_relation_size` 记录变更前后值；
  3. `cd backend && python scripts/check_alembic.py` 通过（单 head + 命名 + 无重复 id + 无孤儿）；
  4. `alembic upgrade head` 与 `alembic downgrade -1` 在本地 `BLF_test` 与 PG 上各跑通一次；
  5. **SQLite 路径不回归**：跑 `grep -rl create_all backend/tests` 命中的那批 SQLite 用例，全绿。
- **风险**：整表重写见 S2-D。

### S2-B · 读侧切换到新列 + 去掉统计路径上的多余 join（P0 + P1，backend）

- **角色**：backend
- **依赖**：S2-A
- **产出**：
  1. `order_info_service.py` 中所有 `AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string()`（`:421`、`:475`、`:613`、`:1245`、`:1252` 共 5 处）改为按方言选择：
     - PG → `AnalysisSalesOrderRow.fulfillment_channel`；
     - 其他方言 → 保留现有 `raw_row[...]` 表达式（**SQLite fallback 必须在**）。
  2. `_extract_fulfillment_channel()`（`:238`，应用层过滤用）与 `serialize_order_row()`（`:122`）优先读新列，取不到再回落到现有 `raw.get()` 逻辑。
  3. **（P1）** `compute_stats()` 的主聚合与主导币种两条 SQL 去掉 `_build_base_query()` 带来的 `analysis_source_files` / `projects` 两个 inner join：投影已被 `with_only_columns()` 抹掉，所有过滤条件打在行级冗余列上（`apply_sql_filters` 全用 `AnalysisSalesOrderRow.*`），这两个 join 纯属每行一次 `Memoize + Index Scan` 开销（生产计划里 5,449–7,200 次索引探测）。
- **验收标准**：
  1. **语义等价硬断言**：同一筛选下，带 join / 去 join 两条路径的 `total_orders`、`total_quantity`、`total_amount`、`fba_count`、`fbm_count`、`dominant currency` **六个字段全部相等**（写进测试，用 `BLF_test` 真实 PG 跑）。
  2. 行为回归：`backend/tests/services/data/test_order_info_service.py`、`test_order_info_compute_stats_sales_amount.py`、`backend/tests/api/test_order_info_query_guards.py` 全绿。
  3. **反证**：把新列读法临时改回 `raw_row[...]`，新用例必须失败（证明用例真的咬得住）。
  4. 生产 EXPLAIN 对照：去 join 后主聚合耗时不高于 175 ms 基线；若不降反升，**回滚该子项并单独说明**，不得硬留。
- **风险**：去 join 依赖 `source_file_id → analysis_source_files.id → projects.id` 的 FK 完整性（均 `ondelete=CASCADE`，理论无悬挂行）。若验收 1 在真实数据上出现不一致，立即回滚该子项。

### S2-C · 翻页契约：**不新增 `include_stats`**，Stage 3 直接用已有 `/list`（决策，backend 零改动）

- **角色**：backend（仅需确认，不写代码）／frontend（Stage 3 消费）
- **依赖**：无
- **决策与理由**：

  `GET /api/v1/order-info/list` **已经存在**，返回 `items/total/page/page_size`，与 `/overview` 走**同一个** `order_info_service.list_orders()`（同样 `known_total=None`、同样 `_ensure_operator_header`、同样 `_query_timeout_guard`、同样挂在 Stage 1 建的 20s `order-info-read` 代理档）。因此 `include_stats=false` 会是一个与 `/list` **逐字段等价**的重复入口。

  | | 加 `include_stats=false` | 复用 `/list` |
  | --- | --- | --- |
  | 后端代码 | 新参数 + 分支 + 新测试 | **0 行** |
  | 响应 schema | `OrderInfoOverview.stats` 变可空 → 前端类型改 + 每个消费点补空值分支 | **不变** |
  | 翻页 SQL 条数 | 2 条 | 2 条（**相同**） |
  | Stage 3 是否被后端阻塞 | 是 | **否，可立即开工** |
  | 长期维护 | 两个 list-only 入口要同步 | 一个 |

  → **判定：不加 `include_stats`。** Stage 3 的规则固定为：
  - 筛选 / 日期 / 项目变化 → `/overview`（stats 要重算）；
  - **仅翻页或排序变化 → `/list`，并复用最近一次 `/overview` 的 `stats`**（stats 不依赖 page/sort，语义等价）。

- **验收标准**：
  1. 文档化：把上面这张表写进 `backend/app/api/v1/endpoints/order_info.py` 的 `/list` docstring 与 `OrderInfoOverview` 的 docstring（说明何时该用哪个），避免后人再把 `include_stats` 造一遍；
  2. SQL 条数测试：用 SQLAlchemy `event.listens_for(Engine, "before_cursor_execute")` 计数，断言 admin 身份下 `/list?page=2` = **2 条**、`/overview?page=1` = **3 条**；
  3. `/list` 的 `total` 与同筛选 `/overview` 的 `total` 相等（一个来自 count、一个复用 stats.total_orders）。
- **风险**：若将来 `/list` 与 `/overview` 的列表语义分叉（例如 `/overview` 加服务端默认排序），需重开此决策，届时以 `/overview?include_stats` 收敛为唯一入口并把 `/list` 标记 deprecated。

### S2-D · 生产 DDL 窗口与验证（运维 + backend，需人工授权）

- **角色**：backend + 人工授权
- **依赖**：S2-A、S2-B 全部合并到 main 并部署后
- **执行清单**：
  1. 建迁移前强制项（AGENTS.md）：`git fetch origin && git rebase origin/main` → `alembic heads` **确认单 head** → `cd backend && alembic revision --rev-id 278 -m "<中文说明>"`；
  2. **迁移与用到它的代码同一个 PR 合 main**，不得先合迁移；
  3. 上线前查磁盘余量：需 ≥ 1× 表体积（481 MB）空闲；
  4. **维护窗口执行**，并在 DDL 会话前置 `SET lock_timeout = '3s'; SET statement_timeout = '300s';`
     —— 拿不到 ACCESS EXCLUSIVE 就**立即失败退出**，绝不排队堵住 ingest 写入；窗口内暂停订单 ingest 任务更稳；
  5. 执行后立即复测（只读 GET）：
     - `/overview`（全店铺无日期）total 与执行耗时；
     - `/overview?page=2`（若 Stage 3 已上线则为 `/list?page=2`）耗时；
     - 与 §0 基线表逐项对照。
- **验收标准**：
  1. DDL 实际耗时被记录进 PR（本地 1.45 s / 生产待测），窗口 ≤ 5 分钟；
  2. DDL 期间无 ingest 失败、无 `order-info` 5xx；
  3. 生产 `/overview` 宽口径统计耗时较基线 878 ms **下降 ≥ 50%**；窄口径（7 天）不劣化；
  4. 若不达标，**不合并读侧切换（S2-B）**，保留原 `raw_row` 读法，只留列（无害），并把实测写回本 issue 重新决策。

---

## 二、接口契约（本 stage 对外**零新增**）

| 端点 | 变化 |
| --- | --- |
| `GET /api/v1/order-info/overview` | **无变化**（响应 schema、字段、统计语义全部不动） |
| `GET /api/v1/order-info/list` | **无变化**（Stage 3 直接消费） |
| `GET /api/v1/order-info/stats` | 无变化 |
| 数据库 | 新增一列 `analysis_sales_order_rows.fulfillment_channel`（生成列，PG only） |

**明确不做**：不加 `include_stats` 参数、不改 `OrderInfoOverview` schema、不加 `fulfillment_channel` 索引、不把 `raw_row` 换成 `jsonb`（整表重写 + 体积翻倍，收益已被 generated column 吃掉）、不改 keyset/cursor（Stage 4）。

---

## 三、测试要求（T3 档：动了 model + 迁移 → 全量）

- **后端**：新增
  - `backend/tests/services/data/test_order_info_fulfillment_column.py`：新列与 `raw_row` 逐值一致、两个 key 的 COALESCE 语义、等价聚合断言（六字段）、SQL 条数计数；
  - 扩充 `backend/tests/api/test_order_info_query_guards.py`：`/list?page=2` 与 `/overview?page=1` 的 SQL 条数断言。
- **命令**：`cd backend && pytest`（**全量一次**，禁止 `-n auto`，见 AGENTS.md）；失败集在 `origin/main` 上对账，不跑第二遍全量。
- **迁移**：本地 `BLF_test` 跑 `upgrade head` → `downgrade -1` → 再 `upgrade head`；`python scripts/check_alembic.py` 通过。
- **PR 声明**：commit author `jr.way123@gmail.com`；PR 标题含 `BLF-1262`；body 给出 §0 的前后对拍数字；**不得自行合并**。

---

## 四、风险标注

| # | 风险 | 等级 | 处置 |
| --- | --- | --- | --- |
| R1 | **PG 18 上 STORED 生成列 = 整表重写 + ACCESS EXCLUSIVE**（relfilenode 变化已实测） | **高** | S2-D 维护窗口 + `lock_timeout=3s` 立即失败；先在本地同规模表演练；准备回滚 SQL |
| R2 | 生产表 481 MB 且**明显膨胀**（本地同数据仅 156 MB，≈3× 差） | 中 | 上线前 `VACUUM FULL` 不在本次范围，但 DDL 耗时按本地 1.45 s 的 3–10 倍预留窗口 |
| R3 | 去 join 依赖 FK 完整性，理论上可能改变行数 | 中 | S2-B 验收 1 用真实 PG 做六字段等价断言；不一致即回滚该子项 |
| R4 | SQLite 测试方言不支持生成列 / `->>` | 中 | 模型 + 迁移双 dialect 守卫；S2-A 验收 5 强制跑 SQLite 用例 |
| R5 | 生成列口径比现有 SQL 过滤更宽（多认一个空格 key） | **低** | 已核对生产：51,611 行**全部**带 `fulfillment-channel`，空格 key 0 行 → 语义零变化；COALESCE 只作兜底 |
| R6 | 与 Stage 3 并行时契约漂移 | 低 | 本计划已把"翻页走 `/list`"钉死；Stage 3 开工前把 §S2-C 原样贴进其 issue |
| R7 | 本轮不含 Stage 1 的 T4（`pg_stat_statements` 扩展） | 低 | 仍待授权；不影响本 stage（性能验证用 EXPLAIN + 前后对拍即可） |

---

## 五、验收总表（Stage 2 完成定义）

1. S2-A + S2-B + S2-D 全过，PR 合并后生产 `/overview` 宽口径统计耗时下降 **≥ 50%**；
2. 统计六个字段在 PG 上与 Stage 1 基线**逐值相等**（生产只读 GET 对拍 total / total_quantity / total_amount / fba_count / fbm_count / currency）；
3. `pytest` 全量一次跑完，失败集已在 `origin/main` 对账；`check_alembic.py` 绿；
4. 迁移在生产执行的耗时与窗口被记录，DDL 期间无 ingest 失败；
5. Stage 3 可直接消费 `/list`，无需等待任何新接口。