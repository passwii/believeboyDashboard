# Phase 4 — 全量对等验证与切换（Parity + Cutover）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 2 + Phase 3 Exit Criteria 全绿

**Goal:** 证明 Go 栈与 Python 栈行为一致（405 路由 + 21 任务 + 报表管线），然后把生产流量一次性切到 Go，回滚方案就绪。

**Architecture:** 三级验证——①契约测试全绿（`BLF_test`）；②影子流量（生产请求镜像到 Go，对比响应，不影响用户）；③按 10 组灰度切流。每级不通过不得进下一级。

## 任务

### Task 4.1：契约覆盖率对账（405/405）

- [ ] Step 1: 写对账脚本 `go/pkg/testutil/coverage.go`：解析 Python 侧全部 `@router.*` 装饰器（`grep -rhoE` 已验证总数 405）→ 与 Go 侧契约测试清单逐条匹配 → 输出缺失表。缺失 > 0 则打回 Phase 2。
- [ ] Step 2: 资金相关路由（定价/佣金/对账/支付/发票）额外跑生产数据抽样 diff（从 `BLF` 只读抽样，**只读**，用只读账号；写操作一律只在 `BLF_test`）。
- [ ] Step 3: 后端现有 pytest（68,543 行）中与移植相关的 service 测试，确认其断言语义已被 Go 测试覆盖（映射表 `go/PYTEST-MAP.md`）。
- [ ] Step 4: Commit：`test(go): 契约覆盖率 405/405 对账`。

### Task 4.2：影子流量（Shadow Traffic）

- [ ] Step 1: Nginx/代理层把生产读请求（GET）镜像到 Go API（`services/api` staging 实例连**只读副本**），对比状态码 + 响应体 diff，持续 72h，diff 率目标 < 0.1%（排除时间/随机字段）。
- [ ] Step 2: 写请求（POST/PATCH/DELETE）**不镜像执行**，改为录制请求体 → 在 `BLF_test` 回放双跑 diff（防写污染生产）。
- [ ] Step 3: 影子报告每日贴 issue 评论；diff 聚类归因（真 bug vs 预期差异如时间戳），真 bug 打回对应 Phase。
- [ ] Step 4: 72h 达标后 Commit 报告：`docs(go): 影子流量 72h 报告（diff 率 x%）`。

### Task 4.3：Alembic 基线冻结（238 个迁移不翻译）

**背景：** `backend/alembic/versions/` 238 文件；`scripts/check_alembic.py` 在 push/部署时强制单 head。Go 侧用 golang-migrate，但历史迁移一个不译。

- [ ] Step 1: 宣布 schema 冻结日：冻结日之后 Python 侧**禁止新增迁移**（紧急修复走例外审批）。
- [ ] Step 2: 冻结日取生产库 `pg_dump --schema-only` + `SELECT version_num FROM alembic_version`，生成 golang-migrate 基线 `migrations/000001_baseline.sql`（含注释：对应 Alembic revision `<id>`，冻结日期）。
- [ ] Step 3: 验证：空库跑 Go 基线 → 与 `alembic upgrade head` 的空库逐表逐列 diff（`information_schema` 对比脚本），零差异。
- [ ] Step 4: 冻结日之后的新增 schema 变更走 Go `migrations/000002_*.sql`；`check_alembic.py` 在切换后退役（Phase 6）。Commit：`feat(go): DB 基线冻结与 migrate 管线`。

### Task 4.4：切换 Runbook（按 10 组灰度）

顺序：misc/health → inventory → pricing → analysis → ads → crm → digital → reporting → system → agent（与 Phase 2 顺序一致；AI 组单独窗口）。

- [ ] Step 1: 每组切换步骤：代理层切该组路径前缀 → 观察 30min（5xx/延迟/R2/邮件指标）→ 下一组。**每组可独立回滚**（切回 Python 前缀）。
- [ ] Step 2: Celery → Asynq 切换：先停 Beat（不再入新任务）→ 排空 Celery 队列 → 起 gocron/Asynq；`run_job` 类长任务在低峰窗口切。
- [ ] Step 3: 截图链路切换：先 10% 报表走 Rod，对比像素 1 周无异常再全切（fallback sidecar 保持热备 2 周）。
- [ ] Step 4: 全切后观察 48h，指标：API p95 延迟、worker 内存（目标：VPS 总内存占用较 Python 时代降 50%+）、5xx 率、邮件到达率。
- [ ] Step 5: 写切换报告（含每组切换时间点 + 回滚记录，如有）。Commit：`docs(go): 生产切换报告`。

### Task 4.5：回滚预案（切换前必须就绪）

- [ ] Step 1: 回滚触发条件量化（5xx > 1% 持续 5min / 资金计算 diff 告警 / 内存超阈）。
- [ ] Step 2: 一键回滚脚本（代理前缀切回 + Celery worker 重启），演练 1 次（staging），记录耗时（目标 < 5min）。
- [ ] Step 3: 回滚后 Go 侧问题修复流程（hotfix 分支 → 影子验证 → 重新灰度）。

## Exit Criteria

- [ ] 契约 405/405 全绿 + 资金抽样 diff 零差异
- [ ] 影子 72h diff 率 < 0.1%
- [ ] DB 基线零差异验证通过
- [ ] 生产全量切 Go，48h 指标达标，回滚脚本演练通过
