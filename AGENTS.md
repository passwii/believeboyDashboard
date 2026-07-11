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

- `git push origin main` 触发 **`.git/hooks/pre-push`** 自动部署 VPS（`python productEnvAgent/deploy_vps.py --auto`：SSH `root@145.79.143.98` → `git pull --ff-only` → `alembic upgrade head` → `systemctl restart believeboy-api` → 健康检查）。
- **触发条件**：仅当本次 push 命中 `backend/` 路径才部署；纯前端 / docs / 配置改动只推代码、不碰 VPS（前端在 Vercel 自动部署）。
- **递归卡死 bug 已修复（2026-07-09）**：旧 hook 用 `GIT_SKIP_HOOKS=1 git push` 试图绕过自身，但 `GIT_SKIP_HOOKS` 不屏蔽 pre-push，导致 `git push` 反复重入 hook；叠加 github.com 连接常被远端关闭，`git push` 长时间挂起。现已把 hook Step1 改为 `git push --no-verify "$remote" "${push_refspecs[@]}"`，不再递归。
- **只推代码不部署**：`SKIP_POST_PUSH_DEPLOY=1 git push origin main`
- **单独部署**：`python productEnvAgent/deploy_vps.py --auto`
- **deploy 失败怎么办**：pre-push 先完成 push 再跑 deploy；若 deploy 失败，代码已上 `origin/main` 但 VPS 未更新，hook 会打印告警并以 push 成功退出。此时手动 `python productEnvAgent/deploy_vps.py --auto` 补齐即可；重推会因 up-to-date 不再触发 deploy。

## 测试规则

- 前端（顺序）：`pnpm lint` → `pnpm build` → `pnpm test`（Vitest，jsdom，已放开；`*.test.ts(x)` 放单元断言，组件用 `@testing-library/react`）。
- 后端：`cd backend && pytest`（单个 `pytest tests/path::test_x`）。
- 失败立即修；全过再走业务测试清单（交用户手动验）。完整规则见 `docs/REFERENCE.md`。

## 关键约定

- **Projects API**：前端取项目列表用 `/api/v1/projects/manage`（非 `/api/v1/projects`），因其按 `X-Operator` 过滤可见项目。
- **Commit**：中文 + Conventional Commits（feat/fix/docs/test/chore…），scope 中文，subject 动宾短语 ≤50 字无句号。详细见 `chinese-commit-conventions` 技能。
- **Superpowers**：收到任务先检查是否匹配 skill（哪怕 1% 可能）；设计先于编码、测试先于实现、验证先于完成。

## 仓库根指针

- 深度参考（架构 / 部署 / 环境变量 / 数据库 / 广告数据 / 完整测试与反馈模板 / Git 部署）：[docs/REFERENCE.md](./docs/REFERENCE.md)
- 旧权威（已弃用）：[CLAUDE.md](./CLAUDE.md)
- autoReportUpload HTTP ingest 计划：[docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md](./docs/superpowers/plans/2026-07-02-auto-report-http-ingest.md)

## Platform follow-up（BEL-127）

BEL-127 根因是平台注入的 `workdir/AGENTS.md` 模板把 MCP 工具名（`codegraph_status` 等）当 shell 命令让 agent 跑。仓库内文档无法修复（平台每次启动覆盖 `workdir/AGENTS.md`），属平台 owner 事项。建议平台把注入模板改为走 CLI（`codegraph <子命令>`）路径，详见 `docs/REFERENCE.md` 的 CodeGraph 章节与历史 `CLAUDE.md` 的 Platform follow-up 段。
