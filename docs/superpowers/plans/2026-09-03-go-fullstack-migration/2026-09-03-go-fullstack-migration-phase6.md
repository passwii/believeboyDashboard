# Phase 6 — 下线 Python（Decommission）

> 父 plan：`2026-09-03-go-fullstack-migration.md`
> **状态：** ⬜ 未开始
> 前置：Phase 4 全切 + 48h 指标达标（可与 Phase 5 并行）

**Goal:** Python 运行时彻底退出生产，VPS 只剩 Go 二进制 + Postgres + Redis，仓库中 `backend/` 归档保留。

**Architecture:** systemd 4 单元 → 2 单元（`believeboy-go-api` + `believeboy-go-worker`）；`git deploy` 脚本改走 Go 构建；Alembic 退役。

## 任务

### Task 6.1：systemd 与部署脚本切换

**源：** `backend/deploy/systemd/`（believeboy-api / celery / celery-scheduled / beat，共 4 单元）+ `productEnvAgent/deploy_vps.py` + `productEnvAgent/deploy.sh`（`git deploy` 入口）

- [ ] Step 1: 新建 2 个 unit：`believeboy-go-api.service`（`services/api` 二进制，health `/health` 做 `ExecStartPost` 检查）、`believeboy-go-worker.service`（`services/worker`，Asynq+gocron 同进程）。
- [ ] Step 2: 改 `deploy_vps.py`：构建步骤 `go build` 替代 pip/uvicorn 重启；`alembic upgrade head` 改为 `migrate up`（golang-migrate）；健康检查 URL 不变。**`git deploy` 触发条件同步改**：命中 `go/` 才部署（`backend/` 改为仅文档变更不触发）。
- [ ] Step 3: 停旧单元 → 启新单元 → 验证 → 保留旧 unit 文件 2 周（disabled 状态）再删。Commit：`chore(部署): systemd 与 deploy 脚本切换 Go`。

### Task 6.2：VPS 清理与资源验收

- [ ] Step 1: 卸载 Python 虚拟环境依赖（保留系统 python3 最小集，删 `.venv`/celery 相关包）；卸载 Chromium（若 Rod 改用系统 Chrome 则保留其一，决策记文档——07-28 事故的资源教训在此验收）。
- [ ] Step 2: 验收：VPS 总内存占用对比（Python 时代基线 vs Go 时代，目标降 50%+；截图任务峰值单独记录）。
- [ ] Step 3: Redis key 前缀审计：Python 残留缓存 key 清理（避免 Go 读到旧格式踩坑——`cache.py` 的 zlib+JSON 格式与 Go 版 `encoding/json` 必须一致，此处是最后检查点）。

### Task 6.3：仓库归档

- [ ] Step 1: `backend/` 打 git tag `python-final`（最后可运行状态），README 顶部加归档说明（指向 `go/` + 本 plan 目录）。
- [ ] Step 2: 退役 `scripts/check_alembic.py` 门禁（改 CI 只跑 Go 侧 migrate 校验：单 head + 命名规范，逻辑照搬）。
- [ ] Step 3: 本 plan 目录写 `index.md` 收尾（按 plans/README 归集清单：状态+分支+入口表+Phase 进度+tag+数据快照），然后按约定归集（已完成态凝固）。
- [ ] Step 4: 关 Python 相关 issue / 更新 `docs/REFERENCE.md` 架构章节（Python → Go）。

## Exit Criteria

- [ ] 生产 VPS 无 Python worker 进程（`ps aux | grep -i celery/uvicorn` 为空）
- [ ] 内存下降目标达成（数据贴切换报告）
- [ ] `python-final` tag 已 push；`backend/` 归档说明就位
- [ ] 本 plan `index.md` 完成，plan 目录归集
