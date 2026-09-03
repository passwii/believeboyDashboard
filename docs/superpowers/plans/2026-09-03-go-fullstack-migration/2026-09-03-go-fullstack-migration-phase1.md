# Phase 1 — 共享领域包（纯计算，无 HTTP、无 DB）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 0 + Phase S Exit Criteria 全绿（S 跑通的 excelize/COPY/decimal 模式是本 Phase 的起点）

**Goal:** 把 Python 里“纯计算/纯转换”逻辑搬进 `go/pkg/` 下的领域包，每个包带从 pytest 移植的用例。这是**内存与 CPU 优化的主战场**（18 处 `iterrows()`、23 个 pandas 文件大多在此解决），也是资金计算正确性的第一道防线。

**Architecture:** 领域包只收/plain struct、只返回/plain struct + error；**不连 DB、不打 HTTP、不读文件**（文件 IO 留给调用层）。数值一律 `github.com/shopspring/decimal`，时间一律 `Asia/Shanghai`，浮点比较走 Phase 0 的 `DiffJSON` 误差规则。

**全局依赖（本 Phase 引入，锁版本后写进主 plan 风险表）：**
- `github.com/shopspring/decimal`（金额/费率，替代 Python Decimal + numpy 浮点）
- `gonum.org/v1/gonum/stat`（类目分析的 polyfit/mean/std）
- `github.com/xuri/excelize/v2`（读 Excel，替代 openpyxl/pandas read_excel）

## 语义对照表（先写，所有 Task 共同遵守）→ `go/pkg/README-SEMANTICS.md`

| Python 语义 | Go 做法 | 出处文件 |
|-------------|---------|----------|
| `Decimal` 四则 + 除零 | `decimal.Div` 前先 `IsZero` 检查；`_safe_div` 逐个搬（`product_analysis.py:280-309` 有 ~20 个派生列） | `app/tasks/scripts/product_analysis.py` |
| `NaN/None` 混用 | 输入 struct 用 `decimal.NullDecimal`-风格（`Valid bool`）；NaN 视为无效，永不参与聚合 | `app/utils/parsers.py` |
| 时区 | 全部 `time.LoadLocation("Asia/Shanghai")`；DB 读出的 timestamptz 转本地再算 | `app/core/scheduler.py`（北京时间语义） |
| pandas `groupby().agg(lambda)` | 改写为“SQL GROUP BY（Phase 2）或 Go map 分组 + decimal 累加”，**禁止直译 lambda** | `app/services/payment/aggregate.py:27-62` |
| `np.polyfit` 趋势 | `gonum/stat` 线性回归；先对 `market_trend.py:24-26,112-114,188-189` 建 5 组黄金用例 | `app/services/category/analytics/market_trend.py` |

- [ ] **Step 0（Task 1.0）：** 以 Phase S 沉淀的 `DECISIONS.md` + 语义坑清单为底稿，写完上表文档并经人工 review 通过，再开工后续 Task。Commit：`docs(go): 数值/时区语义对照表`。

## 任务

### Task 1.1：定价引擎 → `go/pkg/pricing`

**源文件（只读）：** `backend/app/services/pricing/`（core.py / fees.py / inbound.py / fbm.py / cost_reverse.py / reverse.py / computation.py / constants.py，约 10 文件）

- [ ] Step 1: 用 CodeGraph `impact` 确认 `pricing/` 被哪些 endpoint/service 调用（调用方清单写入包 README，后续 Phase 2 接线用）。
- [ ] Step 2: `constants.py` 费率表 → `pkg/pricing/tables.go`（纯数据，逐值搬运，单测断言行数一致）。
- [ ] Step 3: `fees.py` → `fees.go`（decimal 全替换 float）；`inbound.py` → `inbound.go`；`fbm.py` → `fbm.go`。
- [ ] Step 4: `cost_reverse.py` / `reverse.py` → `reverse.go`（反向求解的迭代收敛条件原样搬，收敛阈值用 decimal 比较）。
- [ ] Step 5: `core.py` 编排 → `engine.go`（输入输出 struct 先定，后续 Phase 2 的 schema 对齐它）。
- [ ] Step 6: 把现有 pytest 定价用例逐个译为 Go 表驱动测试（`engine_test.go`），**用例数不得少于 Python 侧**；`go test ./pkg/pricing/ -v` 全绿。
- [ ] Step 7: 🔴 **资金红线**：写双跑 diff 脚本（Python 函数 vs Go 函数，同输入 CSV），逐行 diff 零差异；结果贴 PR 描述。Commit：`feat(go): 定价引擎领域包（含双跑零差异报告）`。

### Task 1.2：库存算法 → `go/pkg/inventory`

**源文件：** `backend/app/services/inventory/`（health_score.py / seasonal_factor.py / replenishment.py / replenishment_snapshot.py / state_action.py；`ledger.py` 的纯函数部分；DB 读写部分留 Phase 2）

- [ ] Step 1: 拆分 `ledger.py`：纯计算函数进本包，`db.execute…all()` 循环列清单给 Phase 2（SQL-first 改写）。
- [ ] Step 2: 健康分/季节因子/补货/状态机逐文件搬运；状态机转移表写成表格单测（全转移覆盖）。
- [ ] Step 3: pytest 库存用例移植；`go test ./pkg/inventory/ -v` 全绿后 Commit：`feat(go): 库存算法领域包`。

### Task 1.3：解析器 → `go/pkg/ingest`（内存优化核心）

**源文件：** `backend/app/utils/parsers.py`（6 处 `iterrows()`）+ `backend/app/services/ad/upload/persistence.py`（875 行，10 个 `_ingest_*_rows`——其中 1 个已在 Phase S 试点跑通，本 Task 复制该模式做剩下 9 个）

- [ ] Step 1: 对每个解析函数，先用生产样例文件（`backend/storage/` 或 R2 样例）录制“输入文件 → 输出行数/字段”黄金快照（存 `pkg/ingest/testdata/`）。
- [ ] Step 2: `excelize` 流式读（`Rows()` 迭代器，**禁止全表 `GetRows()`**）→ 逐行转 struct → 按 batch（默认 1000 行）输出 `[][]any` 给 Phase 2 做 `COPY`。内存目标：万行文件峰值 < 100MB（单测里用 `runtime.MemStats` 断言，可放宽到 CI 机器）。
- [ ] Step 3: 10 个 ad ingest 函数逐个搬，每个配黄金快照测试（行数 + 关键字段抽查）。
- [ ] Step 4: 性能单测：1 万行 payment 文件解析耗时与 Python 版对比（目标 ≥10x；达不到则 profile 找热点，不硬凑）。
- [ ] Step 5: Commit：`feat(go): 流式解析器替代 iterrows（附内存/耗时对比）`。

### Task 1.4：支付聚合与退货分析 → `go/pkg/aggregate`

**源文件：** `backend/app/services/payment/aggregate.py`（89 行，3×groupby-lambda + 2×merge）、`db_reader.py`（`pd.concat` 多源）、`backend/app/services/analysis/return_analysis/persistence.py:246`、`backend/app/services/product/persistence.py:378`

- [ ] Step 1: 聚合逻辑改写为“输入行 struct 切片 → Go map 分组 → decimal 累加”，输出与 Python 版逐字段 diff（黄金用例来自现有 pytest + 生产抽样 3 个项目）。
- [ ] Step 2: 给 Phase 2 留接口说明：这些聚合**优先下推为 SQL**（`Phase2-Task2.6`），本包是 SQL 不易表达时的 fallback；README 写清二选一决策树。
- [ ] Step 3: Commit：`feat(go): 支付/退货聚合领域包`。

### Task 1.5：类目分析 + 告警检测 → `go/pkg/category`、`go/pkg/alert`

**源文件：** `backend/app/services/category/analytics/`（market_trend / review / competition / price_bands）+ `backend/app/services/alert/detector.py` + `reconciliation_detector.py`

- [ ] Step 1: numpy 统计函数 → `gonum/stat`，5 组黄金用例先行（tolerance 1e-9）。
- [ ] Step 2: 告警规则逐条搬（规则 ID/阈值语义原样保留，规则表写进 `alert/rules.go` 注释，格式：`规则名 | 阈值 | 出处行号`）。
- [ ] Step 3: 对账检测（资金相关）走 Task 1.1 Step 7 同款双跑 diff。Commit：`feat(go): 类目分析与告警规则包`。

### Task 1.6：CRM/佣金/财务纯函数 → `go/pkg/crm`、`go/pkg/commission`、`go/pkg/finance`

**源文件：** `backend/app/services/crm/`（rule_engine / sea_reclaim / value_score / filter_engine 纯函数部分）、佣金 service、financial 计算。

- [ ] Step 1: 仅搬无 DB/无邮件的纯函数；凡遇到 `db.` / `resend` / `redis` 调用的，记入 `pkg/*/DEFERRED.md`（Phase 2/3 接）。
- [ ] Step 2: 佣金计算走资金红线双跑 diff。Commit：`feat(go): CRM/佣金/财务纯函数包`。

## Exit Criteria

- [ ] `go/pkg/` 下 7+ 领域包，`go test ./pkg/...` 全绿
- [ ] 资金相关包（pricing/commission/对账）有双跑零差异报告（贴链接或存 `go/pkg/*/_parith_*.md`）
- [ ] `pkg/ingest` 万行文件内存 < 100MB、耗时 ≥10x Python（数据贴 Commit/PR）
- [ ] 每个包 README 有“调用方清单（CodeGraph impact 结论）+ Phase 2/3 接线说明”
