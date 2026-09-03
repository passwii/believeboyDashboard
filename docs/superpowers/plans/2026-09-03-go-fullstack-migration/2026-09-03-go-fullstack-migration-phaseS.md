# Phase S — 先锋验证（Pilot：小切口、高收益、可回滚）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 0 Exit Criteria 全绿
> 后续：Phase 1（复用本 Phase 跑通的模式与语义结论）

**Goal:** 用 1–2 周交付**第一个跑在生产的 Go 程序**：接管一种广告报表的 ingest（替代 10 个 `_ingest_*_rows` 中的 1 个），拿到真实的耗时/内存对比数据，验证技术选型（excelize + pgx COPY + decimal），并且**失败时一键回滚到 Python**。

**为什么选这个切口（三个理由）：**

1. **收益明显**：`backend/app/services/ad/upload/persistence.py`（875 行）里 10 个 `_ingest_*_rows` 全是 `df.iterrows()` + `series.to_dict()` + 逐行 ORM 插入，是全仓最典型的 CPU 热点；单种报表类型搬过去就能看到 10–50x 提速，VPS 内存峰值立即可测。
2. **足够简单**：单个 ingest 函数输入是 1 个 Excel/CSV，输出是 1 张表的批量行，无跨表事务、无 AI 调用、无前端联动；出问题只影响该类型报表的上传任务。
3. **代表性强**：一次跑通“读文件 → 流式解析 → 类型转换 → 批量入库 → 行数/字段 diff”全链路，后面 Phase 1 的 Task 1.3（剩下 9 个 ingest + parsers.py 6 个）就是复制粘贴。

**Architecture:** Go CLI（`go/cmd/ad-ingest`）与 Python 共存；Celery 上传任务在**特性开关**后优先调 Go 二进制（subprocess，传文件路径 + 任务参数），Go 返回 exit code + JSON 摘要（入库行数/跳过行数/耗时）；**非零 exit 或超时 → 自动回落 Python 原逻辑**，用户无感知。DB 直连同一 DSN（读 Phase 0 `pkg/config`），写同一张表。

## 任务

### Task S.1：选定试点类型并录制黄金快照

- [ ] Step 1: 从 10 个 `_ingest_*_rows` 里选**行数最多、字段最杂**的一个（用生产 R2 样例或 `backend/storage/` 样例统计行数，选 Top 1；建议 campaign 或 search-term 类）。
- [ ] Step 2: 用 Python 现逻辑跑 3 份真实样例文件，录制黄金快照：入库总行数 + 每行关键字段哈希（存 `go/cmd/ad-ingest/testdata/golden/*.json`）。
- [ ] Step 3: Commit：`test(go): 试点 ingest 黄金快照（3 份样例）`。

### Task S.2：Go CLI 实现（`go/cmd/ad-ingest`）

- [ ] Step 1: `excelize.Rows()` 流式读（**禁止 `GetRows()` 全表加载**）→ 行转 struct（decimal/时间解析规则先按 Phase 1 语义表草案，差异记 `DECISIONS.md` 给 Phase 1 Task 1.0 终审）。
- [ ] Step 2: pgx `CopyFrom` 批量入库（batch 1000），替换逐行 ORM 插入；连接复用 Phase 0 `internal/store`（若 Phase 0 只建了骨架，此处补最小可用版本，记入 Commit）。
- [ ] Step 3: 输出 JSON 摘要到 stdout：`{"rows": N, "skipped": M, "elapsed_ms": T, "peak_rss_mb": R}`（`peak_rss_mb` 用 `runtime.MemStats` + `/usr/bin/time -v` 双采）。
- [ ] Step 4: 黄金快照测试全绿（行数一致 + 字段哈希一致）。Commit：`feat(go): 试点 ad-ingest CLI`。

### Task S.3：Celery 侧特性开关 + 回落

- [ ] Step 1: 在试点 ingest 的 Celery 任务入口加开关（环境变量 `GO_AD_INGEST=off|shadow|on`，默认 `off`）：
  - `shadow`：Python 照常执行，同时调 Go 跑一遍**只 diff 不采用**（结果写日志/表，连续 3 天零差异再进 `on`）。
  - `on`：采用 Go 结果；Go 失败（exit≠0/超时/行数差异超阈）→ 回落 Python 并告警。
- [ ] Step 2: 开关与回落逻辑走正常 Python PR 流程（Tia review；这是迁移期唯一允许改 `backend/` 的例外：只加开关，不改原逻辑）。
- [ ] Step 3: 生产 `shadow` 跑 3 天 → 贴 diff 报告 → 切 `on` → 观察 1 周。

### Task S.4：验收数据与模式沉淀

- [ ] Step 1: 输出对比报告（贴 PR/issue，同时回填 `…-baseline.md` §六 Go 实测列）：同文件 Python vs Go 的耗时、峰值内存、CPU；目标：耗时 ≥10x，内存峰值 ≤1/3。
- [ ] Step 2: 把跑通的模式沉淀为 Phase 1 的输入：excelize 流式模板、COPY batch 模板、decimal/时区坑清单（更新 `go/pkg/README-SEMANTICS.md` 草案）。
- [ ] Step 3: 若未达目标：profile 找热点修一轮；仍不达标则**诚实记录原因**，由用户决策是否继续 Go 路线（这是 Pilot 的核心价值：低成本证伪）。

## Exit Criteria

- [ ] 试点类型生产 `on` 运行 ≥1 周无回落（或 shadow 零差异 ≥3 天）
- [ ] 对比报告已出（耗时/内存/CPU 三数）
- [ ] 语义坑清单已沉淀，Phase 1 Task 1.0 可直接终审
- [ ] 任一失败场景（Go 崩溃/超时/diff 超阈）都验证过回落链路有效
