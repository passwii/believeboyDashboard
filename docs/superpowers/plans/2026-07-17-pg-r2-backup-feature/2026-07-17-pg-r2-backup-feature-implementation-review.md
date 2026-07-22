# 数据库备份功能 实现评审（deviations from frozen plan）

> 配套主 plan：[`2026-07-17-pg-r2-backup-feature.md`](./2026-07-17-pg-r2-backup-feature.md)
> 续作 plan：[`2026-07-17-pg-r2-backup-feature-continuation.md`](./2026-07-17-pg-r2-backup-feature-continuation.md)
> 实现分支：`feat/pg-r2-backup`，共 19 个 commit（Phase 1–5）。

## 实施概况

按主 plan 11 条决策执行（5 条原 frozen，6 条在续作 plan §2 冻结），Phase 1–5 共 19 个 commit 全部落地：

- 29 个备份相关测试全绿
- **零回归**：worktree 失败清单与 base（`0376328f`）逐条 diff，完全一致（75 个预先存在失败，与备份无关）

## 与 frozen 方案的偏差

### D1. Celery 任务循环导入 → 函数内延迟导入（关键）
- **背景**：`backup_service.py` 模块顶部已 `from app.celery_tasks.backup import run_backup_task`，反向在 task 顶部 `from app.services.backup_service import ...` 会触发循环导入（两个模块顶层互导必炸 ImportError）。
- **修正**：`run_backup_task` 内对 backup_service 的 import 改为函数内 `from app.services.backup_service import (...)` 延迟导入；测试对应改成 patch **源模块** `app.services.backup_service.<func>`（延迟导入在调用时取源模块当前值，patch 源模块同样生效）。
- **影响**：仅 task 模块内部结构变化；测试写法变化（patch 目标迁移）。对生产行为无影响。

### D2. R2 key 结构（修正 M1）
- **背景**：原主 plan §3.3 假设 key = `db-backups/pgbackrest/blf/{date}_{type}_{record_id}.tar.gz`，但实际 `upload_file_to_r2` 拼的是 `{project_slug}/{file_type}/{filename}`，且对每段调用 `_sanitize_key`（filename 里的 `/` 可能被清洗）。
- **修正**：key = `db-backups/pgbackrest/blf_{date}_{type}_{record_id}.tar.gz`（stanza 名 `blf` 进 filename 而非独立路径段，规避 sanitize 风险）。上传参数：`project_slug="db-backups"`, `file_type="pgbackrest"`, `filename=f"blf_{date}_{type}_{id}.tar.gz"`。
- **影响**：实际 R2 上出现的 key 与原 plan 文字略有差异，但语义一致（仍按 `db-backups/pgbackrest/` 前缀分类，含 stanza `blf` 与 record_id 唯一标识）。

### D3. `trigger_backup` 测试 patch 目标（避免 F401）
- **背景**：原 plan 测试把 `trigger_backup` patch 在 `app.api.v1.endpoints.backups` 模块上，但实现会把 `trigger_backup` 从该模块 import 中移除（否则 ruff F401 未用导入），导致 patch 目标不存在。
- **修正**：测试把 `trigger_backup` patch 在**源模块** `app.services.backup_service.trigger_backup`（始终存在），既保留"没走同步路径"的断言又不冲突。

### D4. `run_backup_task` 测试加 autouse 清理 fixture
- **背景**：task 用独立 `SessionLocal` 会话 commit（跨会话可见需真提交），不清理会往共享测试库 `BLF_test` 累积 `backup_records` 行。
- **修正**：`tests/tasks/test_run_backup_task.py` 加 autouse fixture `_cleanup_backup_records`（测试结束 `DELETE FROM backup_records`），避免污染共享测试库。

### D5. 后端 ruff 不适用
- **背景**：原 plan Task 7 步骤 6 写 `ruff check app tests`，但仓库 `backend/pyproject.toml` 无 `[tool.ruff]` 配置，ruff 也未安装；AGENTS.md 后端门槛仅 `pytest`。
- **修正**：跳过 ruff；以后端测试（pytest）作为唯一门槛（已通过 29 个备份测试 + 零回归）。

### D6. 前端 `pnpm build` 在 worktree 软链环境被 Turbopack 拒绝
- **背景**：worktree 没有 `node_modules`，从主目录软链以验证；Next.js 15 Turbopack 拒绝软链形式的 node_modules（"points out of the filesystem root"）。
- **修正**：本地用 `tsc --noEmit` 做类型检查（tsc 跟随软链）。我修改的文件 `backup-management-client.tsx` 类型检查零错误；`pnpm lint` 0 错误。在用户主目录真实 `node_modules` 下 `pnpm build` 可正常完成。
- **影响**：仅为 worktree 环境限制，代码本身无误。

### D7. `enqueue_backup` 加 `triggered_by` 参数
- **背景**：主 plan 没有显式区分 manual / auto 触发的 `triggered_by` 字段入参；Phase 4 `schedule_daily_backup_task` 需要以 `triggered_by="auto"` 入队。
- **修正**：`enqueue_backup(db, backup_type, user_id, settings, triggered_by="manual")` 加 1 个 kwarg（默认 `"manual"` 保持原行为）。原有测试 `test_enqueue_backup_via_celery_true_inserts_pending_record_and_delays_task` 默认入参不变，仍断言 `triggered_by == "manual"`，通过。

### D8. 部署文档写到 `multi-worker-ops.md` 而非 `deployment-runbook.md`
- **背景**：原 plan §5 引用 `docs/deployment-runbook.md`，但仓库实际 `backend/docs/deployment-runbook.md` 与 `backend/docs/multi-worker-ops.md` 并存；systemd 单元表约定在 `multi-worker-ops.md`（scheduled-report 计划即按此前例）。
- **修正**：部署说明（worker unit 表格 + Beat 单实例约束 + 备份 worker 注释）追加到 `backend/docs/multi-worker-ops.md` §1，不新建 deployment-runbook 条目。

## 未完成项（留给用户 / 后续）

### N1. 手动 VPS 联调（用户负责）
- Phase 1 §9 验收清单（worker 起来 → 触发 → 看 phase 推进 → pgbackrest 真跑 → R2 真传）需在 VPS 上实际验证，本地无 pgbackrest / 真实 R2 环境。
- Phase 4/5 Beat 调度验证（crontab 临时调到 5min 后等自动 record 跑完、cleanup 验收）同属手动。
- 续作 plan 中标记为 `- [x]` 的所有子步骤（代码实装）已完成；对应的"手动 VPS 验收"清单保持空白留给用户。

### N2. `BackupStatusSummary.r2_storage_bytes` 字段填充（偏差 B 收尾）
- 主 plan §1.1 提到 `BackupStatusSummary` 已多出一个 `r2_storage_bytes` 字段（原 plan 留空未填），Phase 5 计划填充。
- 现状：迁移已落库 `compressed_size_bytes` 等字段，但 `r2_storage_bytes` 的填充逻辑（按未删除 R2 记录的 `compressed_size_bytes` 求和）**本次未实装**，留作未来增量。如需可加一个简单的 sum 查询。

### N3. 恢复干跑端点（Phase 2 末）
- 主 plan §3.9 提到 `POST /backups/{id}/restore-dry-run`（真跑 `pgbackrest restore --dry-run` 返回日志）作为可选增强。
- 现状：本次实装了 `GET /backups/{id}/restore-command`（命令预览，不执行），未实装 dry-run 端点。生产可在后续增量补齐。

---

## 验收

- ✅ 19 个 commit 落地 `feat/pg-r2-backup` 分支
- ✅ 29 个备份测试全绿
- ✅ 零回归（与 base diff 验证）
- ✅ 前端 `pnpm lint` 0 错误，`tsc` 类型检查干净
- ⏳ VPS 手动联调（pgbackrest 真跑 + R2 真传 + Beat 自动触发）由用户在部署后验证