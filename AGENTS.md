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

- **用 `git deploy` 推送，部署由 GitHub Actions 执行**（2026-10-15 起，替代本地直连部署）：`git deploy` = 校验 main 分支 + `backend/` 改动时跑迁移图检查 + `git push origin main`；**VPS 部署交给 `.github/workflows/deploy-vps.yml`**（push 后自动跑 `python productEnvAgent/deploy_vps.py --auto`，runner 从公网 SSH `root@145.79.143.98` → `git pull --ff-only` → 停后台单元 → `alembic upgrade head` → 启回 worker/beat → 健康检查）。为什么搬走：本地 IP 可能被 fail2ban 拦、机器可能不在线，且 push 与部署解耦后天然串行（workflow 有 `concurrency: vps-deploy` 锁）。
- **触发条件**：仅当本次 push 命中 `backend/` 路径才部署（workflow 用 `git diff --name-only $before $sha` 判定，与 `deploy.sh` 口径对齐）；纯前端 / docs / 配置改动只推代码、不碰 VPS（前端在 Vercel 自动部署）。
- **必须从 main 分支跑**：脚本会检查 `symbolic-ref --short HEAD`，非 main 直接报错退出。
- **为什么不用 pre-push hook**：pre-push 跑在 push 之前，要触发"push 后 deploy"就得 hook 自己 `git push --no-verify`，结果原始 push 还会再跑一次 → `remote rejected` 噪音。改用显式 `git deploy` 单一 push、可观察、无竞态。
- **跳过本次部署**：commit message 带 `[skip ci]`（GitHub 内建跳过，workflow 整个不跑）。
- **查看 / 手动触发 / 只预览**：`gh run list --workflow deploy-vps.yml --limit 3` / `gh workflow run deploy-vps.yml` / `gh workflow run deploy-vps.yml -f dry_run=true`。
- **本地兜底部署（CI 不可用时）**：`LOCAL_DEPLOY=1 git deploy`，或直接 `python productEnvAgent/deploy_vps.py --auto`（需本机 SSH 可达 VPS）。
- **deploy 失败怎么办**：代码已在 `origin/main` 但 VPS 未更新；workflow 失败会在 step summary 打出 bad-sha 与回滚命令，照 `productEnvAgent/ROLLBACK.md` 走回滚（`python productEnvAgent/rollback.py --bad-sha <sha> --auto --force`）。重推不会重触发（universe 无新 commit），必须用 `gh workflow run deploy-vps.yml` 重跑。
- **新机器首次配置 alias / 缺 secret**：`git config alias.deploy '!bash productEnvAgent/deploy.sh'`；CI 侧 secret 为 `VPS_SSH_KEY` / `VPS_KNOWN_HOSTS` / `VPS_HOST`，设置方法见 [docs/REFERENCE.md](./docs/REFERENCE.md) §Git 提交与部署。

## 测试规则

**按变更面分流，不默认全量**（完整版见 [docs/REFERENCE.md](./docs/REFERENCE.md) §测试规则（完整））：

| 档 | 场景 | 后端 | 前端 |
| --- | --- | --- | --- |
| **T0** | 只改 `docs/`、注释或文案，且不改变运行行为 | 不跑 | 不跑 |
| **T1** | 叶子改动：单个工具函数 / 单个组件，仅影响局部实现，未触发下方 T3 条件 | 目标文件（~8s） | `vitest run <该文件/目录>`（~10s） |
| **T2** | 局部功能：新增端点 / 新页面，未触发下方 T3 条件 | 目标集 + 该目录回归 | Vitest 目标用例 + 该目录回归 + `pnpm lint` |
| **T3** | 跨模块 / 高风险：公共 hook、schema、model、**迁移**、权限、共享 utils | **全量（单次；耗时以当次实测为准）+ 失败集对账** | 全量（BLF-1238 已修好：235 文件 / 1660 例 / **~43s**，同机满载约 2 分钟）+ lint；build 交 Vercel |

**判档优先级：** 表格场景用于初步归类；若与下方条件冲突，按更高档执行，命中任一 T3 条件即升 T3。三项条件是：① 改动跨模块复用的公共符号、共享契约或其行为（用 CodeGraph `callers` / `impact` 确认影响面）；② 改动迁移或权限逻辑；③ 改动 `app/core/config.py` 的配置字段 / 默认值，或 `app/models/*`、`app/schemas/*` 的字段、约束、序列化契约。仅注释 / 文案改动不因此升档。字段级改动对目标集不可见，因此相关行为改动必须全量验证。

**E2E 不按 T 档一刀切：** 涉及登录、权限隔离、NextAuth、前后端代理或关键跨服务用户流程时，跑对应 Playwright 用例；纯业务逻辑 / API 行为优先用 pytest 覆盖，不为凑档位盲目跑 E2E。运行前按入口文档准备测试数据库和前后端服务：前端见 [TESTING.md](./TESTING.md)，后端见 [agent_testing README](./backend/scripts/agent_testing/README.md)。前端命令：`cd frontend && pnpm test:ui -- tests/<area>/<name>.spec.ts`；后端 agent E2E：`cd backend && pytest scripts/agent_testing/<test_file>.py -v`。
- **前端可裸跑全量**（BLF-1238 已修）：`pnpm test` = 235 文件 / 1660 例 / **~43s**（本机较空闲）～**~2 分钟**（同机其他 agent 满载，实测 59s / 79s / 124s）。T1/T2 仍优先带路径过滤，T3 才跑全量；判「挂住」不看绝对秒数，看是否在推进（见下条）。
- **卡住判型（BLF-1238 教训）**：跑到 60s 仍无 `Test Files` 汇总 + 某 worker 长时间 100%+ CPU = 某文件**无限渲染循环**（不是「慢」）；`--testTimeout` / `vi.waitFor` 救不了（微任务链饿死计时器，表现为永久挂起而非超时失败）。二分与根因规则见 [TESTING.md](./TESTING.md) §前端单测。
- **mock 稳定性机械检查（BLF-1247）**：`cd frontend && pnpm check:mocks`——扫 `frontend/**/*.test.{ts,tsx}`，命中「mock 工厂里内联新建 `useSession.data` / `useNotifications.notify`」即 `exit 1` 并给 `file:line` + 修法（已接进 `pnpm test` 入口，命中则 vitest 不启动）。修法一律用 `frontend/test-utils/stable-mocks.ts` 的 `stableSession()` / `stableNotifications()`；**不要在脚本里加白名单放过**（判据自测在 `frontend/scripts/check-unstable-mocks.test.mjs`）。口径详见 [TESTING.md](./TESTING.md) §机械拦截。
- **失败集对账（替代基线全量）**：PR 上全量只跑一次并记录失败项；仅对 main 上存在的失败用例文件，在相同命令 / 环境下对账一次，不再跑第二遍全量。PR 与 main 出现相同失败时，记录为既有失败，不误报为本次回归；新增用例无法在 main 对账，需单独复现。若失败不稳定，只定向重跑失败用例确认并记录；修复本次引入的问题，不用 `skip` / `xfail` 隐藏失败。
- 后端没有 CI（`.github/workflows` 无后端任务），T3 的后端全量仍不能省。若遇到 [backend/tests/README.md](./backend/tests/README.md) 记录的 `PROD_DATABASE_URL` 导入期收集失败，视为测试收集阻塞、不能报全绿；记录具体错误并修复或隔离导入链后再确认覆盖。**不要用 `pytest -n auto`**：共享 `BLF_test` 上 autouse `TRUNCATE` 会让 worker 互相死锁（实测 225 failed / 155 errors）。
- 命令：后端 `cd backend && pytest`（单个 `pytest tests/path::test_x`）；前端 `pnpm lint` / `pnpm build`（可交 Vercel）/ `vitest run <路径>`（Vitest，jsdom，已放开；`*.test.ts(x)` 放单元断言，组件用 `@testing-library/react`）。
- **本地数据库测试（BLF-472）**：前后端测试一律在本地完成、不依赖远程 VPS——本地 Postgres（端口 5432）常驻 `BLF`（生产快照，每日与生产拉取同步，数据完备，供集成 / 手动读写 / 真实数据验证）与 `BLF_test`（pytest 隔离库，`scripts/setup_test_db.py` 创建）。pytest 一律走 `BLF_test`，绝不写 `BLF`。详见 [TESTING.md](./TESTING.md)。
- 新增失败立即修；确认是基线既有失败的，按上面的失败集对账规则记录，不误报为本次回归。新增问题修复并完成对应技术验证后，再走业务测试清单（交用户手动验）。

> 本节引用的实测数字（420s / 900s、225 failed / 155 errors、前端全量 43s / 59s / 79s / 124s 等）为 **Damon 本机（macOS）2026-10-05 / 10-06 单次实测**，只作量级参考，**不是通用基准**；本机常与其他 agent 并发，前端全量耗时对同机负载很敏感，换机器 / 换时段请以当次实测为准。

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

## Platform follow-up（BEL-127）

BEL-127 根因是平台注入的 `workdir/AGENTS.md` 模板把 MCP 工具名（`codegraph_status` 等）当 shell 命令让 agent 跑。仓库内文档无法修复（平台每次启动覆盖 `workdir/AGENTS.md`），属平台 owner 事项。建议平台把注入模板改为走 CLI（`codegraph <子命令>`）路径，详见 `docs/REFERENCE.md` 的 CodeGraph 章节与历史 `CLAUDE.md` 的 Platform follow-up 段。

## Platform follow-up（pi-lens LSP 误报，2026-10-16）

**症状**：`lens_diagnostics(source=lsp)` 在本仓库大量报 `TS2307 Cannot find module 'vitest' / 'framer-motion' / 'lucide-react' / '@radix-ui/*' / 'recharts' / 'gsap' / 'tailwindcss'`、`TS7016 Could not find a declaration file`、`TS7006 implicitly has an 'any' type`，**包括本 session 完全没碰过的文件**（例：`frontend/lib/motion/routes.test.ts`）。

**根因**：pi-lens 的 `typescript-language-server` 未应用 `frontend/tsconfig.json`（`moduleResolution: "bundler"`），退化为 node10 语义 → 所有只走 `exports` 的包装配都解析失败。**不是仓库代码问题**。

**已实测无效的仓库侧修复（勿重复尝试）**：

| 尝试 | 结果 |
| --- | --- |
| 仓库根新增 `tsconfig.json`（extends `frontend/tsconfig.json`） | ❌ 误报不变 |
| `.pi-lens.json` → `lsp.serverOverrides.typescript.initializationOptions.typescript.tsdk`（相对 / 绝对路径各一次，指向 `frontend/node_modules/typescript/lib`） | ❌ 误报不变 |
| `.pi-lens.json` → `rules."2307"/"7016"/"7006".disable` | ❌ 无效（`rules.<id>` 只认 pi-lens 自有 rule id，非 LSP 数字码） |
| 删除 `tsconfig.tsbuildinfo` + touch 文件/tsconfig 触发重解析 | ❌ 误报不变 |

**判定它是否误报的四条证据**（照跑即可）：

```bash
cd frontend
# ① 未改动的文件报同样的错 → 与本次改动无关
npx tsc --noEmit --pretty false --moduleResolution node10 lib/motion/routes.test.ts   # 复现 LSP 同类错
npx tsc --noEmit --pretty false --moduleResolution bundler --module esnext \
  --jsx react-jsx --target ES2017 --strict --skipLibCheck lib/motion/routes.test.ts  # 0 个模块错误
# ② 项目 tsc（读 frontend/tsconfig.json）对该文件 0 诊断
npx tsc --noEmit --pretty false | grep lib/motion/routes.test
# ③ 包确实装着
node -e "require.resolve('vitest',{paths:[process.cwd()]})"
# ④ vitest 真跑
npx vitest run lib/motion/routes.test.ts
```

**当前处置**：不用改代码消除它（会掩盖后续真诊断）；用 `lens_diagnostic_mark(disposition="false-positive")` 标注本 session 触碰文件上的误报即可。**权威 TS 门禁是项目 tsc / `pnpm build`（Vercel next build 内置 tsc）/ `pnpm lint` / `pnpm test`，不是 pi-lens 的 LSP 面板。**

