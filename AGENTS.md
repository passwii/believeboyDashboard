# AGENTS.md

> **角色**：本文件是 **ZCode 加载的仓库指令文件**（ZCode 只读本文件，不读 `CLAUDE.md`）。
> 本文件现为**权威指令源**；`CLAUDE.md` 已降级为薄壳（仅兼容旧链接），深度参考见 [`docs/REFERENCE.md`](./docs/REFERENCE.md)。

## CodeGraph：代码定位默认用这个（CLI 路径）

> 本仓库 ZCode / 无 MCP 的 agent 只有 **CLI**（`codegraph <子命令>` 带空格）。`mcp__codegraph__*` 是 MCP 工具名，bash 里跑会 `command not found`。

**定位任何代码：先用 CodeGraph，再用 Read：**
1. `codegraph status .` 确认索引健康（"Index is up to date" 即可；`.` 可省；Not initialized 则 `codegraph init .`）。
2. `codegraph query <符号> --kind <kind>` 拿 `file:line`（**只给位置，不带源码**）。
3. `Read <file:line>` 看源码。
4. 影响面：`codegraph callers <sym>` / `callees <sym>` / `impact <sym>`（无 `--limit`，输出可能很长）。
5. 浏览：`codegraph files --path <相对目录>`（`.` / `backend` / `frontend`）。

**坑**：`explore` / `node` 无 CLI 等价（别跑 `codegraph explore`）；`query` 只给位置；新 worktree 索引丢要重跑 `codegraph status .`；写后等约 1 秒再查；长期改动前 `codegraph sync .` 增量更新（别用 `init`）。MCP 路径（已配 `mcpServers.codegraph` 时）见 `docs/REFERENCE.md`。

## Push / 部署规则（重要）

- **用 `git deploy` 推送 + 部署**（替代旧的 pre-push hook）：`git push origin main` 后脚本自动判断 — 若 `origin/main..HEAD` 命中 `backend/` 则跑 `python productEnvAgent/deploy_vps.py --auto`（SSH `root@145.79.143.98` → `git pull --ff-only` → `alembic upgrade head` → `systemctl restart believeboy-api` → 健康检查）。
- **触发条件**：仅当本次 push 命中 `backend/` 路径才部署；纯前端 / docs / 配置改动只推代码、不碰 VPS（前端在 Vercel 自动部署）。
- **必须从 main 分支跑**：脚本会检查 `symbolic-ref --short HEAD`，非 main 直接报错退出。
- **为什么不用 pre-push hook**：pre-push 跑在 push 之前，要触发"push 后 deploy"就得 hook 自己 `git push --no-verify`，结果原始 push 还会再跑一次 → `remote rejected` 噪音。改用显式 `git deploy` 单一 push、可观察、无竞态。
- **只推代码不部署**：`git push origin main`（直接 push，绕过 alias）
- **单独部署**：`python productEnvAgent/deploy_vps.py --auto`
- **deploy 失败怎么办**：代码已上 `origin/main` 但 VPS 未更新，脚本会以非零退出并提示手动 `python productEnvAgent/deploy_vps.py --auto` 补齐；重推会因 up-to-date 不再触发 deploy。
- **新机器首次配置 alias**：`git config alias.deploy '!bash productEnvAgent/deploy.sh'`

## 测试规则

- 前端（顺序）：`pnpm lint` → `pnpm build` → `pnpm test`（Vitest，jsdom，已放开；`*.test.ts(x)` 放单元断言，组件用 `@testing-library/react`）。
- 后端：`cd backend && pytest`（单个 `pytest tests/path::test_x`）。
- **本地数据库测试（BLF-472）**：前后端测试一律在本地完成、不依赖远程 VPS——本地 Postgres（端口 5432）常驻 `BLF`（生产快照，每日与生产拉取同步，数据完备，供集成 / 手动读写 / 真实数据验证）与 `BLF_test`（pytest 隔离库，`scripts/setup_test_db.py` 创建）。pytest 一律走 `BLF_test`，绝不写 `BLF`。详见 [TESTING.md](./TESTING.md)。
- 失败立即修；全过再走业务测试清单（交用户手动验）。完整规则见 `docs/REFERENCE.md`。

## 关键约定

- **Projects API**：前端取项目列表用 `/api/v1/projects/manage`（非 `/api/v1/projects`），因其按 `X-Operator` 过滤可见项目。
- **Commit**：中文 + Conventional Commits（feat/fix/docs/test/chore…），scope 中文，subject 动宾短语 ≤50 字无句号。详细见 `chinese-commit-conventions` 技能。
- **Superpowers**：收到任务先检查是否匹配 skill（哪怕 1% 可能）；设计先于编码、测试先于实现、验证先于完成。
- **Plans 目录约定**：已完成 plan 归集到 `docs/superpowers/plans/<日期-slug>/` 子目录；进行中 plan 仍平铺（下一新 plan 起推荐从一开始就建子目录）。详见 [docs/superpowers/plans/README.md](./docs/superpowers/plans/README.md)。
- **Alembic 迁移命名（遵循 [docs/REFERENCE.md](./docs/REFERENCE.md) §数据库与迁移）**：
  - 文件名 `YYYYMMDD_NNN_description.py`，revision id 用**纯数字短 ID**（如 `'215'`），`NNN` 从最新迁移递增、**不从 1 重计**；**严禁**裸跑 `alembic revision -m "..."`（默认生成 `a5571a96e542` 这类随机 hash）。
  - 建迁移：`cd backend && alembic revision --rev-id <下一序号> -m "<中文说明>"`（先 `ls alembic/versions | grep ^2026 | sort | tail` 看最新序号）。
  - **多 worktree 并行撞车时**（两分支迁移挂同一 `down_revision` → 多 head）：汇合后跑 `alembic merge heads --rev-id <下一序号> -m "merge xxx"` 生成合并迁移（`down_revision=(A, B)`）把单链接回，**不要**手工加 `b` 后缀或重排序号（历史 `20260415_095b`、重复 `114` 即手工躲撞的教训）。
  - **多 worktree 防撞流程（建迁移前必做）**：碰撞根因是建迁移时 `down_revision` 选错，故**建前先同步 main 取单链**——`git fetch origin && git rebase origin/main` → `alembic heads` 确认只有一个 head → 再 `alembic revision --rev-id <下一序号>`。建完**随 feature 分支同批合 main**（迁移与用它代码一起上线），**不要建完立即合 main**（会令 schema 先于业务代码触发 prod 部署）。其他 worktree 要用迁移前先 rebase/pull main 拿最新单链再重复。详见 [docs/REFERENCE.md](./docs/REFERENCE.md) §数据库与迁移。
  - **已部署到 prod 的迁移禁止改 revision id / 重命名**（prod `alembic_version` 按 id 追踪，改了会找不到版本）；仅未部署的可改。
  - **机械检查**：push / 部署前自动跑 `backend/scripts/check_alembic.py`（单 head + 命名 + 无重复 id + 无孤儿；git deploy / pre-push hook / VPS 部署均挂载），失败即阻断并提示 `alembic merge heads` 修复；手动跑 `cd backend && python scripts/check_alembic.py`。
  - 主键统一 `Integer`（对齐 `alert_rule.py` 屋风与模型 `Mapped[int]`），勿用 `BigInteger`。

## 仓库根指针

- 深度参考（架构 / 部署 / 环境变量 / 数据库 / 广告数据 / 完整测试与反馈模板 / Git 部署）：[docs/REFERENCE.md](./docs/REFERENCE.md)
- 旧权威（已弃用）：[CLAUDE.md](./CLAUDE.md)
- autoReportUpload HTTP ingest 计划：[docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md](./docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md)
